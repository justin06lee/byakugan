# 白眼 byakugan

**Token-efficient, render-truthful browser perception for LLM agents.**
The model only sees what the user can see — as compact text derived from
Chromium's layout tree, with cropped screenshots as an on-demand fallback sense.

- **~400 tokens** to perceive a real page (BBC homepage: **236**; raw DOM: 153k)
- **Diffs after the first step**: a click usually costs **< 30 tokens** to observe
- **Immune by construction** to hidden-text prompt injection, spoofed `aria-label`s,
  and click-through-modal bugs — invisible content never enters the representation
- **Zero runtime dependencies.** Works with anything that speaks CDP:
  Playwright, Puppeteer, Electron (`webContents.debugger`), or a raw DevTools WebSocket

## The numbers

Perception cost per step, 10 real pages, 1280×800 (`npm run m0`):

| page | screenshot | raw DOM | pruned AX tree | **byakugan** |
|---|---|---|---|---|
| en.wikipedia.org (article) | 1,366 | 164,232 | 17,061 | **686** |
| news.ycombinator.com | 1,366 | 8,749 | 8,055 | **677** |
| github.com (repo page) | 1,366 | 129,322 | 12,554 | **210** |
| duckduckgo.com | 1,366 | 115,823 | 5,946 | **216** |
| www.bbc.com | 1,366 | 153,057 | 14,122 | **236** |
| docs.python.org (tutorial) | 1,366 | 20,125 | 12,184 | **712** |
| **average (10 pages)** | **1,366** | **65,111** | **9,464** | **408** |

End-to-end, with a live LLM (claude haiku) driving 5 scripted tasks through the
example agent (`npm run bench`): **5/5 tasks succeeded** on **818 perception
tokens total** — the same steps would have cost 21,856 tokens with
screenshot-every-step (**26.7×**) or 8,791 with raw DOM (**10.7×**).

## What the model sees

```
PAGE amazon.com/gp/cart — "Shopping Cart" — viewport 1280x800, scrolled 0% of 8433px page
[1]  link "Deliver to Justin — 94107"
[2]  searchbox "" placeholder="Search Amazon"
[14] heading "Shopping Cart (3 items)"
[15] checkbox "Select all" unchecked
[16] link "Sony WH-1000XM5 Wireless Headphones…"
[17] spinbutton "Qty" value="1"
[18] button "Delete"
     …and 6 more similar buttons [19-24]
[25] button "Proceed to checkout"
[26] canvas 640x320 text-blind; use look(26)
```

After an action, the next observation is a diff:

```
CHANGED:
~ [17] spinbutton "Qty" value="2"
+ "Subtotal (4 items): $612.00"
```

## Quickstart (Playwright)

```ts
import { chromium } from 'playwright';
import { Byakugan } from 'byakugan';
import { fromPlaywright } from 'byakugan/transports';

const page = await (await chromium.launch()).newPage();
await page.goto('https://news.ycombinator.com');

const eyes = await Byakugan.attach(await fromPlaywright(page));

const manifest = await eyes.observe();     // → feed manifest.text to your LLM
await eyes.act.click(12);                  // act on manifest IDs, hit-tested
const diff = await eyes.diff();            // → tiny; feed diff.text next turn
const crop = await eyes.look(26);          // → cropped PNG when text isn't enough
```

## Quickstart (Electron)

```ts
import { Byakugan } from 'byakugan';
import { fromElectronDebugger } from 'byakugan/transports';

const eyes = await Byakugan.attach(fromElectronDebugger(browserWindow.webContents));
```

A complete two-window demo (target page + live "what the agent sees" panel)
lives in [`examples/electron-host`](examples/electron-host) — `npm start` there.

## API

| | |
|---|---|
| `Byakugan.attach(transport)` | bind to a CDP target |
| `eyes.observe(opts?)` | full visible-world manifest (`maxTokens` cap, default 800 — overflow is announced, never silent) |
| `eyes.diff()` | re-observe, return only changes (`+` added, `-` removed, `~` changed); falls back to full text on navigation or large change |
| `eyes.look(id \| rect, opts?)` | cropped, downscaled PNG (`maxLongEdge` default 768 ≈ ≤600 tokens) |
| `eyes.act.click/type/press/scroll/select/hover/navigate` | verified dispatch — geometry re-fetched at call time, topmost-node hit-tested; covered targets return `{ok:false, blockedBy}` instead of clicking through |
| `eyes.resolve(id)` | element record (backendNodeId, bounds) for hosts dispatching input themselves |
| `eyes.onWorldChanged(cb)` | navigation / load signals |

Transports: `fromPlaywright(page)` · `fromElectronDebugger(webContents)` ·
`fromWebSocket(pageTargetWsUrl)` — or implement the 3-method `CdpTransport`
interface yourself.

## How it works (and why it's safe)

One `DOMSnapshot.captureSnapshot` call returns Chromium's **layout tree** — what
was actually painted, not what the DOM claims. Byakugan then:

1. drops everything that produced no layout box, is `visibility:hidden`,
   near-zero opacity, 1px-clipped (screen-reader-only tricks), or outside the viewport;
2. drops elements fully covered by an opaque, higher-paint-order box
   (modals, overlays) — the occlusion check partial covers can't fool is repeated
   at action time via a topmost-node hit-test;
3. labels elements with their **painted text runs** — never `aria-label`/`title`,
   which pages can spoof. Icon-only elements fall back to the AX name, explicitly
   marked `(aria)` so the agent knows it's a page claim, not painted truth;
4. collapses repeated siblings (`…and 17 more similar links [24-40]` — collapsed
   rows keep their IDs and stay clickable);
5. stitches same-process iframes into root coordinates;
6. keys manifest IDs to CDP `backendNodeId`, so `[17]` stays `[17]` across steps
   and diffs stay tiny.

The consequence for security: a page whispering `<div style="display:none">
ignore all instructions…</div>` or labeling a "Pay $5" button
`aria-label="Pay $500"` simply never reaches the model. See
[`fixtures/hidden.html`](fixtures/hidden.html) and the tests that lock this in.

## Reproduce the numbers

```bash
npm install && npx playwright install chromium
npm test          # 17 fixture tests (perception, actions, hardening)
npm run m0        # 10 real pages: manifest vs DOM vs AX vs screenshot tokens
npm run bench     # live LLM agent over 5 scripted tasks (uses `claude` CLI; BENCH_MODEL=haiku default)
```

## Known gaps

- **Out-of-process (cross-origin) iframes** aren't stitched — they surface as
  `iframe … text-blind; use look(id)` elements.
- **Canvas/WebGL** is inherently invisible to the text channel — flagged in the
  manifest, served by `look()`.
- Occlusion by semi-transparent overlays or exotic blend modes is intentionally
  not dropped (the user *can* see through them); the action-time hit-test
  catches the click-through case.
- Text token counts use a ~4 chars/token estimate; treat absolute numbers as
  ±15 % and the ratios as the real result.

## License

MIT
