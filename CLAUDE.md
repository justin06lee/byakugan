# byakugan — AI context

Everything an AI (or new contributor) needs to understand this codebase, how it
works internally, and **whether it's the right tool for a given job**.

## What this is (and is not)

Byakugan is a **standalone TypeScript library** that gives LLM browser agents
token-efficient, render-truthful perception of web pages over the Chrome
DevTools Protocol (CDP). It converts what Chromium *actually painted* into a
compact, stable-ID text manifest (~200–800 tokens/page), emits sub-30-token
diffs between steps, verifies actions against fresh geometry at dispatch time,
and falls back to cropped screenshots (`look()`) when text can't represent
something.

It is deliberately **not**:
- a browser (the consumer is a separate Electron-based agentic browser project),
- an agent or LLM harness (the agent loop in `examples/agent.ts` is a demo, not API),
- a DOM/HTML scraper (it never reads raw DOM attributes for content).

Keep agent loops, LLM plumbing, and browser UI **out of `src/`** — examples only.

## Is byakugan the right tool?

**Use it when:**
- An LLM needs to *perceive and act on* rendered web pages repeatedly
  (multi-step agent loops) and token cost matters.
- You need resistance to page-level deception: hidden-text prompt injection,
  spoofed `aria-label`s, click-through-modal bugs. Byakugan is immune to these
  *by construction* — invisible content never enters the representation.
- You have any CDP access: Playwright/Puppeteer, Electron
  `webContents.debugger`, or a raw DevTools WebSocket URL.

**Do NOT use it when:**
- You need full-page content extraction regardless of visibility (scraping,
  archiving, reading below-the-fold without scrolling). Byakugan only shows
  the current viewport; agents scroll to see more — that's the point.
- The target isn't Chromium (no Firefox/WebKit — the layout-tree snapshot is
  a Chromium CDP feature).
- The page is mostly canvas/WebGL (games, map apps, design tools) — byakugan
  flags those regions `text-blind` and you'd end up screenshotting every step
  anyway; plain screenshots may be simpler.
- You need cross-origin iframe *text* (payment widgets, embedded auth). OOPIFs
  aren't stitched; only `look(id)` sees them.
- One-shot question answering about a page where a single screenshot suffices.

**Measured trade-off** (see README for tables): ~408 avg tokens/page vs 1,366
(screenshot) / 9,464 (pruned AX) / 65,111 (raw DOM); live haiku agent 5/5 tasks
on 818 total perception tokens (26.7× cheaper than screenshot-every-step).

## Core design principles (do not violate)

1. **Rendered truth only.** Every fact shown to the model derives from
   Chromium's layout tree (`DOMSnapshot.captureSnapshot`) — what was painted —
   never from raw DOM attributes. AX-derived names are allowed only as
   fallback for icon-only elements and must be marked `(aria)`.
2. **Text first, pixels on demand.** The manifest is the primary sense;
   `look()` is the escalation, never the default.
3. **Never resend the world.** After the first `observe()`, steps get `diff()`.
   Full re-observe only on navigation or large change (>50% of elements).
4. **No silent truncation.** Token budgets cut with an announced
   `…N more elements truncated` line, never quietly.
5. **Host-agnostic, zero runtime deps.** Everything goes through the 3-method
   `CdpTransport` interface. `playwright` and `electron` are dev/peer concerns
   only — the electron transport uses structural typing so there's no import.

## Repo map

```
src/
  index.ts        public exports: Byakugan, observe, Actions, IdAllocator,
                  estimateTextTokens/estimateImageTokens + all types
  byakugan.ts     stateful Byakugan class: attach/observe/diff/look/resolve/
                  onWorldChanged, owns IdAllocator + nav tracking, `act` field
  observe.ts      THE CORE (~450 lines): snapshot → filter → label → collapse
                  → render pipeline; Manifest/ElementRecord/ObserveOpts types
  actions.ts      Actions class: click/type/press/scroll/select/hover/navigate
                  with fresh-geometry + hit-test verification; ActionResult
  ids.ts          IdAllocator: Map<backendNodeId → small int>, clear() on nav
  tokens.ts       estimateTextTokens (chars/4), estimateImageTokens ((w×h)/750,
                  1568px long-edge downscale — Claude's formula)
  transport.ts    CdpTransport { send, on, detach }
  transports/     fromPlaywright / fromElectronDebugger / fromWebSocket
                  (subpath export `@justin06lee/byakugan/transports`)
examples/
  agent.ts        demo agent loop + ClaudeCliLLM (spawns `claude -p`) and
                  AnthropicApiLLM — reference, not API
  electron-host/  two-window Electron demo (target + live manifest panel)
scripts/
  m0.ts           10-real-page token comparison (writes m0-output/)
  bench.ts        live-LLM benchmark: 5 fixture tasks with verify predicates
fixtures/         self-contained HTML test pages (see "Fixtures" below)
tests/            18 node:test tests via tsx: perception(8)/actions(6)/hardening(4)
SPEC.md           original design spec with milestones M0–M4 (all shipped)
```

## How observe() works (src/observe.ts)

One `DOMSnapshot.captureSnapshot` call (with computed styles for
`display/visibility/opacity/cursor/clip/clip-path/background-color`) returns
parallel arrays describing the layout tree. Pipeline:

1. **Document recursion** — `emitDoc(docIdx, ox, oy, depth)` walks each
   document; same-process iframes recurse via `contentDocumentIndex` with
   scroll-adjusted offsets so child coordinates land in root-viewport space.
   OOPIFs have no contentDocumentIndex → emitted as `text-blind` iframes.
2. **Visibility filters** — drop: no layout box; `visibility:hidden`;
   opacity ≤ 0.05; boxes ≤ 1.5px (sr-only trick); `clip:rect(0...)`;
   `clip-path:inset(≥50%)`; outside viewport intersection.
3. **Occlusion** — collect opaque occluders (background alpha ≥ 0.95, area
   ≥ 40,000px²); post-pass drops elements fully covered by a higher
   paint-order occluder unless it's an ancestor/descendant. Semi-transparent
   overlays intentionally do NOT occlude (humans see through them);
   action-time hit-testing covers that case.
4. **Labeling** — painted text runs (`layout.text`) are the label source.
   Text items with no letters/digits (`[\p{L}\p{N}]`) are noise-filtered.
   Icon-only elements (symbol-only painted text) get the AX name annotated
   as `(aria "…")`. Form state comes from snapshot rare-data:
   `inputValue`, `inputChecked`, `optionSelected` (selects render
   `value="X" options=[...]` — critical, haiku failed the bench without it).
5. **Interactive detection** — tag allowlist + roles + `contenteditable` +
   `tabindex` + (`isClickable` ∧ `cursor:pointer`). Interactive elements get
   IDs from the shared `IdAllocator` (keyed by `backendNodeId`, so IDs are
   stable across steps → diffs stay small).
6. **Repetition collapse** — sibling runs ≥ 5 with same shape keep the first
   3, then `…and N more similar <role>s [minId-maxId]`. Collapsed rows KEEP
   their IDs and ElementRecords (marked `(collapsed)`) so they remain
   actionable. Never collapse away actionability.
7. **Render + budget** — lines assembled under `maxTokens` (default 800);
   overflow announced explicitly.

Returns `Manifest { text, elements: ElementRecord[], otherLines, meta {url,
title, viewport, scrollPct, frameCount, tokens} }`;
`ElementRecord = { id, backendNodeId, role, label, bounds, line }`.

## How Byakugan (state) works (src/byakugan.ts)

- `attach(cdp)`: `Page.enable`, subscribes to lifecycle + `frameNavigated`
  (sets `navPending`).
- `observe()`: clears the `IdAllocator` if navigation happened (IDs are only
  stable within a document generation).
- `diff()`: re-observes; compares ElementRecords by id/line → `+`/`-`/`~`
  lines; non-element text compared as a multiset. Falls back to full manifest
  text on navigation or >50% element churn. No change → `"NO CHANGE"`.
- `look(id | rect, {maxLongEdge=768})`: `DOM.getBoxModel` → viewport→document
  coords → `Page.captureScreenshot` with clip + `captureBeyondViewport`.
- `resolve(id)`: last manifest first, then falls back to a `seen` map of every
  element observed this document generation — so elements that merely scrolled
  out of the viewport stay actionable (actions re-derive geometry at dispatch;
  truly removed nodes still fail cleanly there). Cleared with the IdAllocator
  on navigation.
- `onWorldChanged(cb)`: navigation/load `ChangeHint`s for the host.

## How actions verify (src/actions.ts)

Every action re-derives truth at dispatch time — never trusts stale manifest
bounds:

1. `DOM.getContentQuads` for fresh geometry (retries after
   `scrollIntoViewIfNeeded` if empty).
2. `DOM.getNodeForLocation` at the target point → topmost node.
3. Containment check via `Runtime.callFunctionOn`
   (`this.contains(o) || o.contains(this)`).
4. Mismatch → `{ok:false, error, blockedBy: "tag#id.class"}` — the structured
   failure is *the feature*: agents read `blockedBy`, dismiss the blocker,
   retry. Never "fix" this by clicking anyway.

Input goes through `Input.dispatchMouseEvent` / `dispatchKeyEvent` /
`insertText` (browser-level, indistinguishable from a user). `type()` on a
`<select>` returns an error directing to `select()`, which matches option
text/value and dispatches `input`+`change` events.

## Transports (src/transports/)

`CdpTransport = { send<T>(method, params?), on(event, cb), detach() }`.
- `fromPlaywright(page)` — `context.newCDPSession(page)`.
- `fromElectronDebugger(webContents)` — structural `WebContentsLike` type
  (no electron import), `attach('1.3')`, demuxes the message event.
- `fromWebSocket(pageTargetWsUrl)` — global WebSocket, id-keyed pending map.

## Testing & benchmarks

- `npm test` — 17 tests over local `fixtures/*.html` via Playwright chromium.
  Notable locked-in guarantees: all 6 `SECRET-*` hidden-text variants absent
  from manifests (hidden.html); spoofed `aria-label="Pay $500..."` renders as
  painted "Pay $5"; modal occlusion drops covered content AND blocks clicks;
  iframe click coordinates verified against Playwright `boundingBox` truth;
  collapsed list rows still clickable.
- `npm run m0` — real-page token comparison (network-dependent; some sites
  bot-wall headless Chromium — that's byakugan faithfully reporting a block
  page, not a bug).
- `npm run bench` — spawns the `claude` CLI as a headless LLM
  (`claude -p --model haiku --tools "" --no-session-persistence`, prompt via
  stdin; `BENCH_MODEL` env to override). No API key needed — runs on a Claude
  subscription. LLM outputs one-line `ACTION: verb(args)` / `DONE: …`.
- `npm run typecheck` — tsc strict, NodeNext. `npm run build` — tsup, ESM+dts,
  entries `index` + `transports`.

## Fixtures (what each proves)

| fixture | proves |
|---|---|
| basic.html | form controls, icon-only button `(aria)` fallback, canvas flag |
| hidden.html | 6 invisible-text variants + aria-spoof button — none leak |
| modal.html | overlay occlusion + click-block + recovery path |
| occlusion.html | paint-order occlusion edge cases |
| iframe.html | same-process iframe stitching + click-through (uses `<script>` handler — srcdoc `&quot;` in onclick attrs breaks parsing; don't regress) |
| list.html | repetition collapse; hash links (`#item/i` — path links break on file://) |
| dynamic.html | diff correctness (counter/spawn) |
| app.html | mini SPA (shop/cart/settings + validation) for the bench |

## Conventions & constraints

- **Git**: default branch is `master`; feature branch per unit of work,
  `--no-ff` merge to master, annotated tags per release, Conventional Commits.
  Pushing to origin (private repo) is pre-authorized.
- **npm**: published as `@justin06lee/byakugan` (the bare name `byakugan` is
  taken on npm). Releases: bump version, commit, annotated `vX.Y.Z` tag, then
  `npm publish --access public` — the `prepublishOnly` gate runs
  typecheck+tests+build, and the final step needs a one-time password only the
  owner can complete in a browser. Prep everything; the owner finishes the
  publish.
- **Zero runtime dependencies** is a hard constraint. Playwright is a
  devDependency (tests/benchmarks only).
- Node ≥ 20, ESM only, strict TS (typescript 6: `ignoreDeprecations: "6.0"`
  in tsconfig is required for tsup dts).
- Token math: text ≈ chars/4; image ≈ (w×h)/750 after 1568px long-edge
  downscale (Claude's formula). Ratios are the reliable claim, not absolutes.

## Known gaps (documented, not bugs)

1. **OOPIF stitching** — cross-origin iframes surface as
   `iframe … text-blind; use look(id)`. Fixing requires
   `Target.setAutoAttach` + per-frame sessions (future work).
2. **Canvas/WebGL** — no text channel exists; `look()` is the answer.
3. **Semi-transparent occlusion** — deliberately visible (humans see through);
   action-time hit-test catches click-through.

## Current state

v0.2.0 tagged, pushed, and published to npm as `@justin06lee/byakugan`;
M0–M4 all shipped (see SPEC.md milestones). 18/18 tests green, typecheck
clean, `npm pack` → 38.4 kB, 10 files, zero deps. v0.2.0 added the
`resolve()` seen-map fallback for scrolled-out elements.
