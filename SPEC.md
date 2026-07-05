# Byakugan — Library Spec

A standalone TypeScript library that gives LLM browser agents **token-efficient,
render-truthful perception**: the model only ever sees what a human user can
see, as compact text derived from Chromium's layout tree, with cropped
screenshots as an on-demand fallback sense.

Byakugan is **not a browser and not an agent**. It is the eyes. Any host that
can hand it a CDP connection — Electron (`webContents.debugger`), Playwright
(`CDPSession`), Puppeteer, or a raw `--remote-debugging-port` WebSocket — gets
`observe()` / `diff()` / `look()` / verified actions. The agent loop, LLM
plumbing, and browser UI live in the consuming application.

Target: **~100–500 perception tokens per agent step** (vs ~1,300+ for
screenshots every step, ~30k+ for raw DOM), with screenshot-grade behavioral
quality.

---

## 1. Principles

1. **Rendered truth only.** The representation is derived from what Chromium
   painted, never from raw DOM attributes. Invisible, occluded, zero-sized,
   and off-viewport content does not exist in it. This is both the token
   optimization and the security model (hidden-text prompt injection, spoofed
   `aria-label`s, and click-through-modal bugs all die here).
2. **Text first, pixels on demand.** Screenshots are an escalation tool
   (`look`), not the default sense.
3. **Never resend the world.** After the first observation, steps consume diffs.
4. **Host-agnostic.** Core speaks pure CDP. No Electron, Playwright, or
   Puppeteer imports outside thin transport adapters.
5. **No silent truncation.** When budget forces dropping content, the manifest
   says so (`…N elements below the fold`).

## 2. Package layout

Single npm package `byakugan`, subpath exports:

| Export                | Responsibility                                            |
|-----------------------|-----------------------------------------------------------|
| `byakugan`            | Core: `Byakugan.attach(transport)` → perception + actions |
| `byakugan/transports` | Adapters: `fromPlaywright`, `fromPuppeteer`, `fromElectronDebugger`, `fromWebSocket` |
| `byakugan/bench`      | Benchmark harness + fixture task suite (also the test bed) |

```ts
// Electron host
const eyes = await Byakugan.attach(fromElectronDebugger(webContents));
// Playwright host (dev, tests, benchmarks)
const eyes = await Byakugan.attach(fromPlaywright(page));
```

The transport interface is minimal: `send(method, params)`, `on(event, cb)`,
`detach()`. Everything else is core.

## 3. Public API

```ts
interface Byakugan {
  observe(opts?: ObserveOpts): Promise<Manifest>;   // full visible-world snapshot
  diff(): Promise<ManifestDiff>;                    // changes since last observe/diff
  look(target: ElementId | Rect, opts?: LookOpts): Promise<Look>; // cropped, downscaled PNG
  act: Actions;                                     // verified input dispatch (§6)
  resolve(id: ElementId): Promise<HitTestedPoint>;  // for hosts dispatching input themselves
  onWorldChanged(cb: (hint: ChangeHint) => void): Unsubscribe; // nav/mutation signals
  tokenEstimate(m: Manifest | ManifestDiff): number;
}

interface Manifest {
  text: string;          // the LLM-facing representation (§5)
  elements: ElementRecord[]; // id ↔ backendNodeId ↔ geometry, for hosts/tools
  meta: { url, title, viewport, scrollPct, frameCount };
}
```

`Manifest.text` is the product. Everything else exists to make it actionable.

## 4. `observe()` pipeline

One `DOMSnapshot.captureSnapshot` call:
`computedStyles: [visibility, opacity, display, overflow, pointer-events, cursor]`,
`includePaintOrder: true`, `includeDOMRects: true`.

Filter chain (each stage drops nodes):

1. **Layout existence** — node produced a layout box (`display:none` already gone).
2. **Style visibility** — `visibility ≠ hidden`, effective `opacity > 0.05`.
3. **Viewport intersection** — box intersects visual viewport (small margin).
4. **Occlusion** — box not fully covered by opaque nodes of higher paint order.
   Approximation is acceptable; action-time hit-testing is the safety net (§6).
5. **Relevance** — keep nodes that are interactive (AX role, focusability,
   `cursor: pointer`, listeners via `DOMDebugger.getEventListeners`) or carry
   rendered text.

Enrichment:

- **Labels from painted text runs** (snapshot text boxes) — never from
  `aria-label`/`title`, which pages can spoof. The AX tree
  (`Accessibility.getFullAXTree`) contributes role/state only (checked,
  expanded, disabled); the layout tree vetoes existence.
- **Repetition collapse** — runs of ≥4 structurally similar siblings emit 2
  exemplars + `…and N more similar rows [ids]`.
- **Stable IDs** — manifest IDs map to `backendNodeId` and are reused across
  steps while the node survives, keeping diffs small.

## 5. Manifest text format

Plain text, one element per line — no JSON overhead:

```
PAGE amazon.com/gp/cart — "Shopping Cart" — viewport 1280x800, scrolled 0%
[1]  link "Deliver to Justin — 94107" (topbar)
[2]  searchbox "" placeholder="Search Amazon"
[3]  button "Go"
[14] heading "Shopping Cart (3 items)"
[15] checkbox "Select all" state=unchecked
[16] link "Sony WH-1000XM5 Wireless Headphones…"
[17] spinbutton "Qty" value=1
[18] button "Delete"
     …and 2 more similar rows [19-24]
[25] button "Proceed to checkout" emphasized
CANVAS [26] 640x320 — text channel blind here; use look(26)
```

Budget: **≤ 800 tokens** hard cap (configurable). Overflow triggers stronger
repetition collapse, then region summarization — never silent truncation.

Diff output:

```
CHANGED after click [25]:
NAV → amazon.com/checkout — "Checkout"
- removed [14-25] (cart list)
+ [30] radiogroup "Delivery options" (2 options)
+ [31] button "Place your order" emphasized
```

`diff()` is driven by CDP lifecycle/frame/mutation signals surfaced through
`onWorldChanged` — no polling. Full re-observe only on navigation or when the
diff would exceed ~50% of a manifest.

## 6. Actions (`byakugan.act`)

`click(id)`, `type(id, text)`, `press(key)`, `scroll(dir | toId)`,
`select(id, value)`, `hover(id)`.

Every element action re-verifies at dispatch time:

1. `backendNodeId → DOM.getContentQuads` — fresh geometry, never cached.
2. **Hit-test**: is this node (or a descendant) topmost at the target point?
   If not, return a structured failure — `{ ok: false, blockedBy: '[modal
   "Cookie consent"]' }` — instead of clicking through. ~30 tokens that save a
   wasted agent iteration, and the backstop for §4's occlusion approximation.
3. Dispatch via `Input.dispatchMouseEvent` / `dispatchKeyEvent` (browser-level
   input, not synthetic JS events pages can detect).

Byakugan does **not** decide *whether* an action is allowed (consent for
payments etc. is host policy). It only guarantees the action lands on what the
manifest claimed was there.

## 7. `look()`

`Page.captureScreenshot` with `clip` = target rect (padded), downscaled so the
long edge ≤ 768px (≈ ≤600 tokens; element crops typically 200–400). Returned
with metadata so hosts can auto-attach on canvas regions or after repeated
action failures — the escalation *policy* belongs to the host/agent; the
capability lives here.

## 8. Known gaps (accepted for v1)

- **OOPIF iframes**: per-frame snapshots + coordinate stitching (M3).
- **Occlusion approximation**: semi-transparent overlays/blend modes can fool
  paint-order math — mitigated by action-time hit-testing.
- **Canvas/WebGL**: opaque to the text channel by nature — flagged in the
  manifest, served by `look()`.

## 9. Benchmarks (`byakugan/bench`) — the proof

Fixture task suite (WebVoyager-style subset + ~10 scripted flows). For each
perception condition, record tokens/step, tokens/task, success rate, steps/task:

| Condition                     | Expected tokens/step |
|-------------------------------|----------------------|
| A. Screenshot every step      | ~1,300               |
| B. Raw DOM every step         | 10k–100k             |
| C. Pruned AX tree             | 2k–8k                |
| D. Byakugan manifest + diff   | **100–500**          |

Release gate for v1: D beats A and C on tokens/task by ≥3× with success rate
within 5% of A. These numbers are the library's README pitch — they must be
reproducible by anyone via `npx byakugan-bench`.

## 10. Milestones

- **M0 — Proof number (≈1 week).** Playwright transport + observe() only.
  Snapshot 10 real pages; print manifest vs raw-DOM vs screenshot token counts.
  *Validates the whole bet before anything else is built.*
- **M1 — Full perception.** diff(), look(), stable IDs, repetition collapse,
  fixture-based snapshot tests ("this page ⇒ exactly this manifest, ≤N tokens").
- **M2 — Actions + bench.** Verified dispatch, hit-test failures, bench harness
  with an example Claude agent loop (in `examples/`, not core).
- **M3 — Hardening.** OOPIF stitching, occlusion edge cases, Electron transport
  tested against a real `webContents`, injection red-team pass on manifest text.
- **M4 — Publish.** Docs, README with bench numbers, npm release.

## 11. Non-goals

- No agent loop, LLM client, or prompt management in core (example only).
- No browser UI of any kind — that's the consuming application.
- No trained vision models / OmniParser-style parsing — the layout tree makes
  it unnecessary for browser content. (Future: a pixel-native backend could
  implement the same interface for non-CDP surfaces.)
- No Firefox/WebKit support in v1 — CDP/Chromium only.
