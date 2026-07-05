import type { CdpTransport } from './transport.js';
import { observe, type Manifest, type ObserveOpts, type ElementRecord } from './observe.js';
import { IdAllocator } from './ids.js';
import { estimateTextTokens, estimateImageTokens } from './tokens.js';

export interface ManifestDiff {
  /** LLM-facing diff text (or full manifest text when full=true). */
  text: string;
  tokens: number;
  /** True when a navigation or large change forced a full re-observe. */
  full: boolean;
  navigated: boolean;
  manifest: Manifest;
}

export interface Look {
  data: Buffer;
  width: number;
  height: number;
  tokens: number;
}

export type ChangeHint = { kind: 'navigated'; url: string } | { kind: 'loaded' };

/**
 * Stateful perception over one CDP target. Holds the stable ID map and the
 * last manifest so diff() can report only what changed.
 */
export class Byakugan {
  private ids = new IdAllocator();
  private last: Manifest | null = null;
  private navPending = false;
  private changeListeners = new Set<(hint: ChangeHint) => void>();

  private constructor(private cdp: CdpTransport) {}

  static async attach(cdp: CdpTransport): Promise<Byakugan> {
    const b = new Byakugan(cdp);
    try { await cdp.send('Page.enable'); } catch { /* may be pre-enabled */ }
    try { await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }); } catch { /* optional */ }
    cdp.on('Page.frameNavigated', (p: any) => {
      if (p?.frame?.parentId) return; // main frame only
      b.navPending = true;
      b.emit({ kind: 'navigated', url: p.frame.url });
    });
    cdp.on('Page.lifecycleEvent', (p: any) => {
      if (p?.name === 'load' || p?.name === 'networkIdle') b.emit({ kind: 'loaded' });
    });
    return b;
  }

  private emit(hint: ChangeHint) {
    for (const cb of this.changeListeners) cb(hint);
  }

  onWorldChanged(cb: (hint: ChangeHint) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  get lastManifest(): Manifest | null {
    return this.last;
  }

  async observe(opts: ObserveOpts = {}): Promise<Manifest> {
    if (this.navPending) {
      this.ids.clear(); // new page: keep IDs short
      this.navPending = false;
    }
    const m = await observe(this.cdp, { ...opts, ids: this.ids });
    this.last = m;
    return m;
  }

  /**
   * Re-observe and report only what changed. Falls back to the full manifest
   * on navigation or when the diff wouldn't be meaningfully smaller.
   */
  async diff(opts: ObserveOpts = {}): Promise<ManifestDiff> {
    const prev = this.last;
    const navigated = this.navPending;
    const next = await this.observe(opts);

    const full = (why: string): ManifestDiff => ({
      text: `${why}\n${next.text}`,
      tokens: estimateTextTokens(why) + next.meta.tokens,
      full: true,
      navigated,
      manifest: next,
    });

    if (!prev) return full('FIRST OBSERVATION');
    if (navigated || prev.meta.url !== next.meta.url) return full(`NAVIGATED → full re-observe`);

    const prevById = new Map(prev.elements.map((e) => [e.id, e]));
    const nextById = new Map(next.elements.map((e) => [e.id, e]));

    const removed: number[] = [];
    for (const e of prev.elements) if (!nextById.has(e.id)) removed.push(e.id);
    const added: ElementRecord[] = [];
    const changed: ElementRecord[] = [];
    for (const e of next.elements) {
      const old = prevById.get(e.id);
      if (!old) added.push(e);
      else if (old.line !== e.line) changed.push(e);
    }

    // Text lines have no IDs; diff them as multisets.
    const count = (lines: string[]) => {
      const m = new Map<string, number>();
      for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const prevText = count(prev.otherLines);
    const nextText = count(next.otherLines);
    const addedText: string[] = [];
    const removedText: string[] = [];
    for (const [l, n] of nextText) for (let k = (prevText.get(l) ?? 0); k < n; k++) addedText.push(l);
    for (const [l, n] of prevText) for (let k = (nextText.get(l) ?? 0); k < n; k++) removedText.push(l);

    if (!removed.length && !added.length && !changed.length && !addedText.length && !removedText.length) {
      const scrollNote = prev.meta.scrollPct !== next.meta.scrollPct
        ? ` (scrolled ${next.meta.scrollPct}%)` : '';
      return { text: `NO CHANGE${scrollNote}`, tokens: 3, full: false, navigated: false, manifest: next };
    }

    const lines: string[] = ['CHANGED:'];
    if (removed.length) lines.push(`- removed ${formatRanges(removed)}`);
    for (const e of added) lines.push(`+ ${e.line}`);
    for (const e of changed) lines.push(`~ ${e.line}`);
    for (const l of removedText.slice(0, 20)) lines.push(`- ${JSON.stringify(unquote(l))}`);
    for (const l of addedText.slice(0, 20)) lines.push(`+ ${JSON.stringify(unquote(l))}`);
    const hiddenText = addedText.length + removedText.length - Math.min(addedText.length, 20) - Math.min(removedText.length, 20);
    if (hiddenText > 0) lines.push(`…and ${hiddenText} more text changes`);

    const text = lines.join('\n');
    const tokens = estimateTextTokens(text);
    if (tokens > next.meta.tokens * 0.5) return full('LARGE CHANGE → full re-observe');
    return { text, tokens, full: false, navigated: false, manifest: next };
  }

  /**
   * Cropped, downscaled screenshot of an element or region — the escalation
   * sense for canvas/imagery/visual verification. Geometry is re-fetched at
   * call time so the crop tracks layout changes since the last observe.
   */
  async look(target: number | { x: number; y: number; w: number; h: number }, opts: { maxLongEdge?: number } = {}): Promise<Look> {
    let rect;
    if (typeof target === 'number') {
      const el = this.last?.elements.find((e) => e.id === target);
      if (!el) throw new Error(`look(${target}): no such element in last manifest`);
      rect = { ...el.bounds };
      try {
        const bm = await this.cdp.send<any>('DOM.getBoxModel', { backendNodeId: el.backendNodeId });
        const q: number[] = bm.model.border;
        const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
        // Quads are viewport-relative; clip coords are document-relative.
        const metrics = await this.cdp.send<any>('Page.getLayoutMetrics');
        const vv = metrics.cssVisualViewport;
        rect = {
          x: Math.min(...xs) + vv.pageX, y: Math.min(...ys) + vv.pageY,
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
        };
      } catch { /* node gone or detached: fall back to last-known bounds */ }
    } else {
      rect = { ...target };
    }

    const PAD = 8;
    const x = Math.max(0, rect.x - PAD);
    const y = Math.max(0, rect.y - PAD);
    const w = Math.max(1, rect.w + PAD * 2);
    const h = Math.max(1, rect.h + PAD * 2);
    const scale = Math.min(1, (opts.maxLongEdge ?? 768) / Math.max(w, h));

    const shot = await this.cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width: w, height: h, scale },
      captureBeyondViewport: true,
      optimizeForSpeed: true,
    });
    const width = Math.round(w * scale);
    const height = Math.round(h * scale);
    return { data: Buffer.from(shot.data, 'base64'), width, height, tokens: estimateImageTokens(width, height) };
  }

  /** Element record for a manifest ID (for hosts dispatching input themselves). */
  resolve(id: number): ElementRecord {
    const el = this.last?.elements.find((e) => e.id === id);
    if (!el) throw new Error(`resolve(${id}): no such element in last manifest — observe() first`);
    return el;
  }
}

function formatRanges(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0], end = sorted[0];
  for (const id of sorted.slice(1)) {
    if (id === end + 1) { end = id; continue; }
    parts.push(start === end ? `[${start}]` : `[${start}-${end}]`);
    start = end = id;
  }
  parts.push(start === end ? `[${start}]` : `[${start}-${end}]`);
  return parts.join(' ');
}

function unquote(l: string): string {
  try { return JSON.parse(l); } catch { return l; }
}
