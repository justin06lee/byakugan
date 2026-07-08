<p align="center">
  <img src="assets/byakugan.svg" width="300" alt="byakugan logo — a manga panel of the byakugan eye">
</p>

<h1 align="center">byakugan</h1>

<p align="center">Cheap, trustworthy eyes for LLM browser agents.</p>

---

Byakugan lets an AI agent "see" a web page for a few hundred tokens instead of
thousands — and guarantees the AI only sees what a human user would actually
see on screen.

## The problem it solves

If you're building an agent that uses a browser, you have to show the model
the page somehow. Every existing option is bad in its own way:

- **Screenshots** cost ~1,300+ tokens *every single step*, and the model has to
  squint at pixels to find things to click.
- **Raw HTML/DOM** is enormous (often 50k–150k tokens per page) and — worse —
  it's *lying territory*. Pages can hide text (`display:none` prompt
  injection), mislabel buttons (`aria-label="Pay $500"` on a "Pay $5" button),
  or leave stale content in the markup. Models get tricked by things no human
  can see.
- **Accessibility trees** are smaller than the DOM but still ~10k tokens and
  still built from page-supplied claims, not from what was rendered.

Byakugan takes a fourth path: it asks Chromium's rendering engine what it
**actually painted**, and turns just the visible part into a short,
ID-labeled text list the model can read and act on.

## What the model gets

```
PAGE shop.example.com — "Shopping Cart" — viewport 1280x800, scrolled 0% of 8433px page
[1]  link "Deliver to Justin — 94107"
[2]  searchbox "" placeholder="Search"
[14] heading "Shopping Cart (3 items)"
[16] link "Sony WH-1000XM5 Wireless Headphones…"
[17] spinbutton "Qty" value="1"
[18] button "Delete"
     …and 6 more similar buttons [19-24]
[25] button "Proceed to checkout"
[26] canvas 640x320 text-blind; use look(26)
```

The agent says "click 25" and byakugan handles the rest — including checking,
at click time, that nothing (like a cookie banner) is covering the button.
If something is, the click is refused with a message saying *what's blocking*,
so the agent can deal with it instead of silently clicking through.

After the first look, the agent doesn't re-read the page. It gets a **diff**:

```
CHANGED:
~ [17] spinbutton "Qty" value="2"
+ "Subtotal (4 items): $612.00"
```

That's usually under 30 tokens per step. When text isn't enough (a chart, a
canvas, an image), the agent can ask for `look(id)` — a cropped screenshot of
just that element, at a fraction of full-screenshot cost.

## Why "render-truthful" matters

Byakugan's core rule: **if a human can't see it, the model never receives it.**
The representation is built from Chromium's layout tree (what got painted),
never from raw DOM attributes (what the page claims). So:

- Hidden-text prompt injection (`<div style="display:none">ignore your
  instructions…</div>`) never reaches the model.
- A button that *shows* "Pay $5" is labeled "Pay $5", even if its
  `aria-label` says something else. Labels come from painted text; the
  accessibility name is only used for icon-only elements, and then it's
  explicitly tagged `(aria)` so the agent knows it's a page claim.
- Content behind a modal is dropped from the manifest, and a second,
  independent check at action time refuses clicks on covered elements.

These aren't aspirations — they're locked in by tests (see
[`fixtures/hidden.html`](fixtures/hidden.html) and `tests/`).

## The numbers (measured, reproducible)

Perception cost per step across 10 real pages at 1280×800 (`npm run m0`):

| | screenshot | raw DOM | pruned AX tree | **byakugan** |
|---|---|---|---|---|
| average tokens/page | 1,366 | 65,111 | 9,464 | **408** |
| www.bbc.com | 1,366 | 153,057 | 14,122 | **236** |
| github.com repo page | 1,366 | 129,322 | 12,554 | **210** |
| en.wikipedia.org article | 1,366 | 164,232 | 17,061 | **686** |

End to end (`npm run bench`): a live claude-haiku agent completed **5/5**
scripted tasks (form filling, a blocked-modal recovery, list navigation,
info extraction) on **818 perception tokens total** — the same steps cost
21,856 tokens with screenshot-every-step (**26.7×** more) or 8,791 with raw
DOM (**10.7×**).

Text token counts use a ~4 chars/token estimate; treat absolutes as ±15% and
the ratios as the real result.

## Using it

Byakugan is a library, not a browser or an agent. It attaches to any Chromium
you already have, through anything that speaks the Chrome DevTools Protocol.
Zero runtime dependencies.

```bash
npm install @justin06lee/byakugan
```

```ts
import { Byakugan } from '@justin06lee/byakugan';
import { fromPlaywright } from '@justin06lee/byakugan/transports';
// also: fromElectronDebugger(webContents), fromWebSocket(devtoolsUrl),
// or implement the 3-method CdpTransport interface yourself

const eyes = await Byakugan.attach(await fromPlaywright(page));

const manifest = await eyes.observe();   // → feed manifest.text to your LLM
await eyes.act.click(25);                // act on manifest IDs, hit-tested
const diff = await eyes.diff();          // → tiny; feed diff.text next turn
const crop = await eyes.look(26);        // → cropped PNG when text isn't enough
```

For Electron hosts, a complete two-window demo (target page + a live
"what the agent sees" panel) lives in
[`examples/electron-host`](examples/electron-host). A minimal working agent
loop (manifest → LLM → action → diff) is in
[`examples/agent.ts`](examples/agent.ts).

## API at a glance

| | |
|---|---|
| `Byakugan.attach(transport)` | bind to a CDP target |
| `eyes.observe(opts?)` | full visible-world manifest (token-capped; overflow is announced, never silent) |
| `eyes.diff()` | re-observe, return only what changed |
| `eyes.look(id \| rect, opts?)` | cropped, downscaled PNG of one element or region |
| `eyes.act.click/type/press/scroll/select/hover/navigate` | verified input dispatch; blocked actions return `{ok:false, blockedBy}` |
| `eyes.resolve(id)` | element record (backendNodeId, bounds) for hosts dispatching input themselves |
| `eyes.onWorldChanged(cb)` | navigation / load signals |

## Honest limitations

- **Cross-origin iframes** (rendered out-of-process by Chromium) aren't
  stitched into the text manifest — they appear as `iframe … text-blind; use look(id)`.
  Same-origin iframes are fully stitched.
- **Canvas/WebGL content** has no text to extract; it's flagged in the
  manifest and served by `look()`.
- Semi-transparent overlays don't hide what's under them (a human can see
  through them too) — the action-time hit-test catches the click-through case.

## Reproduce everything

```bash
npm install && npx playwright install chromium
npm test          # 19 fixture tests (perception, actions, hardening)
npm run m0        # 10 real pages: byakugan vs DOM vs AX vs screenshot tokens
npm run bench     # live LLM agent over 5 scripted tasks (uses the `claude` CLI)
```

## License

MIT
