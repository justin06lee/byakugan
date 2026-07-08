import type { CdpTransport } from './transport.js';
import { estimateTextTokens } from './tokens.js';
import { IdAllocator } from './ids.js';

/**
 * observe(): one DOMSnapshot.captureSnapshot call → filtered, viewport-clipped,
 * render-truthful element manifest. Labels come from painted text runs in the
 * layout tree, never from aria-label/title (pages can spoof those).
 *
 * Coverage: main document plus same-process iframes, stitched into root
 * coordinates. Occlusion: elements fully covered by an opaque, higher-paint-
 * order non-ancestor (modals, overlays) are dropped; partial covers and
 * translucent overlays are kept — action-time hit-testing is the safety net.
 * Known gap: out-of-process iframes (cross-origin) need per-target attach and
 * are not stitched; they appear as iframe elements flagged text-blind.
 */

const STYLE_KEYS = ['display', 'visibility', 'opacity', 'cursor', 'clip', 'clip-path', 'background-color'];

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'combobox', 'listbox', 'textbox', 'searchbox', 'switch',
  'slider', 'option', 'spinbutton',
]);
const MEDIA_TAGS = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'embed', 'object']);
const HEADING_RE = /^h[1-6]$/;
const MAX_FRAME_DEPTH = 3;

export interface ObserveOpts {
  /** Hard cap on manifest text tokens. Overflow is announced, never silent. */
  maxTokens?: number;
  /** Stable ID allocator shared across observations. Fresh one if omitted. */
  ids?: IdAllocator;
  /** Fetch the AX tree for role/state enrichment (icon-only buttons). Default true. */
  includeAx?: boolean;
}

export interface ElementRecord {
  id: number;
  backendNodeId: number;
  role: string;
  label: string;
  bounds: { x: number; y: number; w: number; h: number };
  /** The rendered manifest line — diff() compares these verbatim. */
  line: string;
}

export interface Manifest {
  text: string;
  elements: ElementRecord[];
  /** Non-element lines (text, collapse summaries) for diffing. */
  otherLines: string[];
  meta: {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    scrollPct: number;
    frameCount: number;
    tokens: number;
  };
}

interface Rect { x: number; y: number; w: number; h: number }

interface Item {
  docIdx: number;
  nodeIdx: number;
  backendNodeId: number;
  kind: 'interactive' | 'media' | 'heading' | 'text';
  role: string;
  label: string;
  extras: string[];
  groupKey: string;
  rect: Rect;
  paint: number;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const contains = (a: Rect, b: Rect) =>
  a.x <= b.x + 0.5 && a.y <= b.y + 0.5 && a.x + a.w >= b.x + b.w - 0.5 && a.y + a.h >= b.y + b.h - 0.5;

const isOpaque = (bg: string): boolean => {
  if (!bg || bg === 'transparent') return false;
  const m = bg.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const parts = m[1].split(/[,/]/).map((s) => parseFloat(s));
  return parts.length < 4 || parts[3] >= 0.95;
};

export async function observe(cdp: CdpTransport, opts: ObserveOpts = {}): Promise<Manifest> {
  const maxTokens = opts.maxTokens ?? 800;
  const ids = opts.ids ?? new IdAllocator();

  for (const method of ['DOM.enable', 'Page.enable', 'DOMSnapshot.enable']) {
    try { await cdp.send(method); } catch { /* some hosts pre-enable domains */ }
  }

  // AX tree: role/state enrichment only. Names are used solely as a clearly
  // marked "(aria)" fallback for elements with no painted text (icon buttons) —
  // painted text always wins because pages can spoof aria attributes.
  const axByBackendId = new Map<number, { role: string; name: string }>();
  if (opts.includeAx !== false) {
    try {
      await cdp.send('Accessibility.enable');
      const ax = await cdp.send<{ nodes: any[] }>('Accessibility.getFullAXTree');
      for (const n of ax.nodes) {
        if (n.ignored || n.backendDOMNodeId === undefined) continue;
        axByBackendId.set(n.backendDOMNodeId, {
          role: n.role?.value ?? '',
          name: (n.name?.value ?? '').replace(/\s+/g, ' ').trim(),
        });
      }
    } catch { /* AX unavailable on some targets; degrade gracefully */ }
  }

  const metrics = await cdp.send<any>('Page.getLayoutMetrics');
  const vv = metrics.cssVisualViewport;
  const content = metrics.cssContentSize;
  const vp: Rect = { x: vv.pageX, y: vv.pageY, w: vv.clientWidth, h: vv.clientHeight };
  // DOMSnapshot bounds and scroll offsets are device pixels; everything else
  // here (viewport, size thresholds, action-layer quads) is CSS pixels. On
  // HiDPI displays (dpr 2) the mismatch silently drops the lower half of the
  // viewport and empties scrolled manifests — normalize at the source.
  const dpr = (metrics.visualViewport?.clientWidth && vv.clientWidth)
    ? metrics.visualViewport.clientWidth / vv.clientWidth : 1;

  const snap = await cdp.send<any>('DOMSnapshot.captureSnapshot', {
    computedStyles: STYLE_KEYS,
    includePaintOrder: true,
    includeDOMRects: true,
  });
  const strings: string[] = snap.strings;
  const str = (i: number | undefined) => (i !== undefined && i >= 0 ? strings[i] ?? '' : '');

  interface L { x: number; y: number; w: number; h: number; style: Record<string, string>; text: string; paint: number }

  interface DocCtx {
    docIdx: number;
    nodes: any;
    children: number[][];
    consumed: Uint8Array;
    layoutOf: Map<number, L>;
    clickable: Set<number>;
    inputValue: Map<number, string>;
    inputChecked: Set<number>;
    optionSelected: Set<number>;
    contentDoc: Map<number, number>;
    tagOf: (i: number) => string;
    attrsOf: (i: number) => Record<string, string>;
  }

  const ctxCache = new Map<number, DocCtx>();
  const makeCtx = (docIdx: number, ox: number, oy: number): DocCtx => {
    const doc = snap.documents[docIdx];
    const nodes = doc.nodes;
    const nodeCount: number = nodes.parentIndex.length;

    const rareBool = (r: any) => new Set<number>(r?.index ?? []);
    const rareStr = (r: any) => {
      const m = new Map<number, string>();
      (r?.index ?? []).forEach((ni: number, k: number) => m.set(ni, str(r.value[k])));
      return m;
    };
    const rareInt = (r: any) => {
      const m = new Map<number, number>();
      (r?.index ?? []).forEach((ni: number, k: number) => m.set(ni, r.value[k]));
      return m;
    };

    const layoutOf = new Map<number, L>();
    const lay = doc.layout;
    for (let li = 0; li < lay.nodeIndex.length; li++) {
      const b = lay.bounds[li];
      const style: Record<string, string> = {};
      STYLE_KEYS.forEach((k, si) => (style[k] = str(lay.styles[li]?.[si])));
      layoutOf.set(lay.nodeIndex[li], {
        x: b[0] / dpr + ox, y: b[1] / dpr + oy, w: b[2] / dpr, h: b[3] / dpr,
        style,
        text: str(lay.text?.[li]),
        paint: lay.paintOrders?.[li] ?? 0,
      });
    }

    const children: number[][] = Array.from({ length: nodeCount }, () => []);
    for (let i = 0; i < nodeCount; i++) {
      const p = nodes.parentIndex[i];
      if (p >= 0) children[p].push(i);
    }

    const ctx: DocCtx = {
      docIdx, nodes, children,
      consumed: new Uint8Array(nodeCount),
      layoutOf,
      clickable: rareBool(nodes.isClickable),
      inputValue: rareStr(nodes.inputValue),
      inputChecked: rareBool(nodes.inputChecked),
      optionSelected: rareBool(nodes.optionSelected),
      contentDoc: rareInt(nodes.contentDocumentIndex),
      tagOf: (i) => str(nodes.nodeName[i]).toLowerCase(),
      attrsOf: (i) => {
        const out: Record<string, string> = {};
        const flat: number[] = nodes.attributes[i] ?? [];
        for (let k = 0; k + 1 < flat.length; k += 2) out[str(flat[k])] = str(flat[k + 1]);
        return out;
      },
    };
    ctxCache.set(docIdx, ctx);
    return ctx;
  };

  const visible = (ctx: DocCtx, i: number): L | null => {
    const l = ctx.layoutOf.get(i);
    if (!l) return null;
    if (l.w < 1 || l.h < 1) return null;
    // Screen-reader-only tricks: 1x1 boxes, clip:rect(0..), clip-path:inset(50%+).
    if (l.w <= 1.5 && l.h <= 1.5) return null;
    if (/rect\(\s*0px[, ]+0px[, ]+0px[, ]+0px\s*\)/.test(l.style.clip ?? '')) return null;
    const clipPath = l.style['clip-path'] ?? '';
    if (/inset\(\s*(50|[6-9]\d|100)%/.test(clipPath)) return null;
    if (l.style.visibility === 'hidden' || l.style.visibility === 'collapse') return null;
    const op = parseFloat(l.style.opacity || '1');
    if (!Number.isNaN(op) && op <= 0.05) return null;
    if (l.x + l.w < vp.x || l.x > vp.x + vp.w || l.y + l.h < vp.y || l.y > vp.y + vp.h) return null;
    return l;
  };

  const consume = (ctx: DocCtx, root: number) => {
    const stack = [...ctx.children[root]];
    while (stack.length) {
      const n = stack.pop()!;
      ctx.consumed[n] = 1;
      stack.push(...ctx.children[n]);
    }
  };

  /** Rendered text of a subtree — layout-tree text runs only. */
  const paintedText = (ctx: DocCtx, root: number, budget: number): string => {
    let out = '';
    const walk = (n: number) => {
      if (out.length >= budget) return;
      if (ctx.nodes.nodeType[n] === 3) {
        const t = squash(ctx.layoutOf.get(n)?.text ?? '');
        if (t) out += (out ? ' ' : '') + t;
        return;
      }
      for (const c of ctx.children[n]) walk(c);
    };
    for (const c of ctx.children[root]) walk(c);
    return clip(squash(out), budget);
  };

  const roleOf = (t: string, attrs: Record<string, string>): string => {
    const ariaRole = (attrs.role ?? '').toLowerCase();
    if (INTERACTIVE_ROLES.has(ariaRole)) return ariaRole;
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const type = (attrs.type ?? 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    return 'clickable';
  };

  const isInteractive = (ctx: DocCtx, i: number, t: string, attrs: Record<string, string>, l: L): boolean => {
    if (INTERACTIVE_TAGS.has(t)) return (attrs.type ?? '').toLowerCase() !== 'hidden';
    if (INTERACTIVE_ROLES.has((attrs.role ?? '').toLowerCase())) return true;
    if (attrs.contenteditable === 'true' || attrs.contenteditable === '') return true;
    if (attrs.tabindex !== undefined && parseInt(attrs.tabindex, 10) >= 0) return true;
    if (ctx.clickable.has(i) && l.style.cursor === 'pointer') return true;
    return false;
  };

  const items: Item[] = [];
  const occluders: { docIdx: number; nodeIdx: number; rect: Rect; paint: number }[] = [];

  const emitDoc = (docIdx: number, ox: number, oy: number, depth: number) => {
    if (depth > MAX_FRAME_DEPTH || !snap.documents[docIdx]) return;
    const ctx = makeCtx(docIdx, ox, oy);
    const { nodes } = ctx;
    const nodeCount: number = nodes.parentIndex.length;

    // Opaque, sizable, viewport-intersecting boxes can occlude what's below them.
    for (const [ni, l] of ctx.layoutOf) {
      if (nodes.nodeType[ni] !== 1) continue;
      if (l.w * l.h < 40_000) continue;
      if (!isOpaque(l.style['background-color'])) continue;
      if (l.x + l.w < vp.x || l.x > vp.x + vp.w || l.y + l.h < vp.y || l.y > vp.y + vp.h) continue;
      occluders.push({ docIdx, nodeIdx: ni, rect: { x: l.x, y: l.y, w: l.w, h: l.h }, paint: l.paint });
    }

    const groupKeyOf = (i: number, role: string) => {
      const p = nodes.parentIndex[i];
      const pClass = p >= 0 ? ctx.attrsOf(p).class ?? '' : '';
      return `${docIdx}|${role}|${ctx.attrsOf(i).class ?? ''}|${pClass}`;
    };
    const push = (nodeIdx: number, kind: Item['kind'], role: string, label: string, extras: string[], l: L, groupKey?: string) => {
      items.push({
        docIdx, nodeIdx, backendNodeId: nodes.backendNodeId[nodeIdx], kind, role, label, extras,
        groupKey: groupKey ?? groupKeyOf(nodeIdx, role),
        rect: { x: l.x, y: l.y, w: l.w, h: l.h },
        paint: l.paint,
      });
    };

    // Single depth-first pass. DOMSnapshot serializes nodes in document order
    // (parents before descendants), so consumption marking works in one sweep.
    for (let i = 0; i < nodeCount; i++) {
      if (ctx.consumed[i]) continue;
      const type = nodes.nodeType[i];

      if (type === 3) {
        const l = visible(ctx, i);
        const text = squash(l?.text ?? '');
        if (!text) continue;
        // Pure-punctuation separators ("|", "(", "·") carry no information.
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        let anc = nodes.parentIndex[i];
        while (anc >= 0 && nodes.nodeType[anc] !== 1) anc = nodes.parentIndex[anc];
        const prev = items[items.length - 1];
        if (prev?.kind === 'text' && prev.docIdx === docIdx && prev.nodeIdx === anc) {
          prev.label = clip(squash(prev.label + ' ' + text), 300);
        } else {
          const ancL = anc >= 0 ? ctx.layoutOf.get(anc) : undefined;
          push(Math.max(anc, 0), 'text', 'text', clip(text, 300), [], ancL ?? l!,
            anc >= 0 ? groupKeyOf(anc, 'text') : `${docIdx}|text`);
        }
        continue;
      }

      if (type !== 1) continue;
      const t = ctx.tagOf(i);
      if (t === 'script' || t === 'style' || t === 'noscript' || t === 'template') { consume(ctx, i); continue; }
      const attrs = ctx.attrsOf(i);
      const l = visible(ctx, i);

      // Same-process iframe: recurse into its document, stitched into root coords.
      if (t === 'iframe' && ctx.contentDoc.has(i)) {
        if (l) {
          const childIdx = ctx.contentDoc.get(i)!;
          const childDoc = snap.documents[childIdx];
          emitDoc(childIdx, l.x - (childDoc.scrollOffsetX ?? 0) / dpr, l.y - (childDoc.scrollOffsetY ?? 0) / dpr, depth + 1);
        }
        consume(ctx, i);
        continue;
      }

      if (!l) continue; // children may still be visible (overflow); don't consume

      if (HEADING_RE.test(t)) {
        push(i, 'heading', 'heading', paintedText(ctx, i, 120), [], l);
        consume(ctx, i);
        continue;
      }

      if (isInteractive(ctx, i, t, attrs, l)) {
        let role = roleOf(t, attrs);
        if (!role) continue;
        const ax = axByBackendId.get(nodes.backendNodeId[i]);
        // Upgrade the generic 'clickable' role using the AX tree's computed role.
        if (role === 'clickable' && ax?.role && INTERACTIVE_ROLES.has(ax.role.toLowerCase())) {
          role = ax.role.toLowerCase();
        }
        let label = paintedText(ctx, i, 100);
        const extras: string[] = [];
        if (!label && attrs.alt) label = clip(squash(attrs.alt), 100);
        // Icon-only elements: fall back to the AX name, explicitly marked as
        // page-claimed rather than painted (aria can lie; painted text can't).
        if (!label && ax?.name) {
          label = clip(ax.name, 100);
          extras.push('(aria)');
        } else if (label && ax?.name && ax.name !== label && !/[\p{L}\p{N}]/u.test(label)) {
          // Painted label is a bare glyph ("✕", "☰"): keep it, annotate the claim.
          extras.push(`(aria ${JSON.stringify(clip(ax.name, 60))})`);
        }
        if (t === 'select') {
          // Options aren't painted while the dropdown is closed, but they ARE
          // what the user would see on click — surface them for select().
          const optionLabels: string[] = [];
          let selectedLabel = '';
          const walkOpts = (n: number) => {
            if (ctx.tagOf(n) === 'option') {
              const textKids = ctx.children[n].filter((c) => nodes.nodeType[c] === 3);
              const lbl = squash(textKids.map((c) => str(nodes.nodeValue[c])).join(' '));
              if (lbl) {
                optionLabels.push(lbl);
                if (ctx.optionSelected.has(n)) selectedLabel = lbl;
              }
              return;
            }
            for (const c of ctx.children[n]) walkOpts(c);
          };
          walkOpts(i);
          extras.push(`value=${JSON.stringify(selectedLabel || (optionLabels[0] ?? ''))}`);
          extras.push(`options=${JSON.stringify(optionLabels.slice(0, 8))}`);
        } else if ((t === 'input' || t === 'textarea' || role === 'combobox') && role !== 'checkbox' && role !== 'radio') {
          const v = ctx.inputValue.get(i);
          if (v) extras.push(`value=${JSON.stringify(clip(v, 60))}`);
          if (attrs.placeholder) extras.push(`placeholder=${JSON.stringify(clip(attrs.placeholder, 60))}`);
        }
        if (role === 'checkbox' || role === 'radio' || role === 'switch') {
          extras.push(ctx.inputChecked.has(i) ? 'checked' : 'unchecked');
        }
        if (attrs.disabled !== undefined || attrs['aria-disabled'] === 'true') extras.push('disabled');
        push(i, 'interactive', role, label, extras, l);
        consume(ctx, i);
        continue;
      }

      if (MEDIA_TAGS.has(t)) {
        const label = t === 'img' ? clip(squash(attrs.alt ?? ''), 80) : '';
        const size = `${Math.round(l.w)}x${Math.round(l.h)}`;
        const extras = [size];
        if (t === 'canvas' || t === 'video' || t === 'iframe') extras.push('text-blind; use look(id)');
        // Tiny decorative images/icons aren't worth a line each.
        if (t === 'img' && l.w * l.h < 2000 && !label) { consume(ctx, i); continue; }
        if (t === 'svg') { consume(ctx, i); continue; } // icons; painted text inside is rare
        push(i, 'media', t, label, extras, l);
        consume(ctx, i);
        continue;
      }
    }
  };

  emitDoc(0, 0, 0, 0);

  // Occlusion: drop items fully covered by an opaque, higher-paint-order box
  // that is not their own ancestor/descendant (modal dialogs keep their own
  // contents; buttons underneath the dialog disappear).
  const isRelated = (docIdx: number, a: number, b: number): boolean => {
    const parent = ctxCache.get(docIdx)!.nodes.parentIndex as number[];
    for (let n = parent[b]; n >= 0; n = parent[n]) if (n === a) return true;
    for (let n = parent[a]; n >= 0; n = parent[n]) if (n === b) return true;
    return false;
  };
  const visibleItems = items.filter((it) => {
    for (const oc of occluders) {
      if (oc.paint <= it.paint) continue;
      if (!contains(oc.rect, it.rect)) continue;
      if (oc.docIdx === it.docIdx && (oc.nodeIdx === it.nodeIdx || isRelated(it.docIdx, oc.nodeIdx, it.nodeIdx))) continue;
      return false;
    }
    return true;
  });

  // Repetition collapse: runs of ≥5 consecutive same-shaped items keep 3.
  // Collapsed items still receive IDs and records so they remain actionable.
  const collapsed: (Item | { summaryRole: string; hidden: Item[] })[] = [];
  let run: Item[] = [];
  const flushRun = () => {
    if (run.length >= 5) {
      collapsed.push(...run.slice(0, 3));
      collapsed.push({ summaryRole: run[0].role, hidden: run.slice(3) });
    } else {
      collapsed.push(...run);
    }
    run = [];
  };
  for (const it of visibleItems) {
    if (run.length && (it.groupKey !== run[0].groupKey || it.kind !== run[0].kind)) flushRun();
    run.push(it);
  }
  flushRun();

  // Render with ID assignment and hard token budget (announced truncation).
  const rootDoc = snap.documents[0];
  const url = str(rootDoc.documentURL);
  const title = str(rootDoc.title);
  const scrollable = Math.max(0, (content?.height ?? vp.h) - vp.h);
  const scrollPct = scrollable ? Math.round((vp.y / scrollable) * 100) : 0;
  const header =
    `PAGE ${url.replace(/^https?:\/\//, '')} — ${JSON.stringify(clip(squash(title), 80))} — ` +
    `viewport ${vp.w}x${vp.h}, scrolled ${scrollPct}%` +
    (scrollable > 0 ? ` of ${Math.round(content.height)}px page` : '');

  const elements: ElementRecord[] = [];
  const otherLines: string[] = [];
  const lines: string[] = [header];
  let budgetUsed = estimateTextTokens(header);
  let dropped = 0;

  for (const entry of collapsed) {
    let line: string;
    let record: ElementRecord | undefined;
    if ('summaryRole' in entry) {
      const hiddenIds: number[] = [];
      for (const h of entry.hidden) {
        if (h.kind === 'text') continue;
        const id = ids.idFor(h.backendNodeId);
        hiddenIds.push(id);
        elements.push({
          id, backendNodeId: h.backendNodeId, role: h.role, label: h.label,
          bounds: h.rect,
          line: `[${id}] ${h.role} ${JSON.stringify(h.label)} (collapsed)`,
        });
      }
      const range = hiddenIds.length
        ? ` [${Math.min(...hiddenIds)}-${Math.max(...hiddenIds)}]` : '';
      line = `     …and ${entry.hidden.length} more similar ${entry.summaryRole}${entry.hidden.length > 1 ? 's' : ''}${range}`;
    } else if (entry.kind === 'text') {
      line = `     ${JSON.stringify(entry.label)}`;
    } else {
      const id = ids.idFor(entry.backendNodeId);
      const parts = [`[${id}]`, entry.role];
      if (entry.label || entry.kind === 'interactive') parts.push(JSON.stringify(entry.label));
      parts.push(...entry.extras);
      line = parts.join(' ');
      record = {
        id, backendNodeId: entry.backendNodeId, role: entry.role, label: entry.label,
        bounds: entry.rect,
        line,
      };
    }
    const cost = estimateTextTokens(line) + 1;
    if (budgetUsed + cost > maxTokens - 15) { dropped++; continue; }
    budgetUsed += cost;
    lines.push(line);
    if (record) elements.push(record);
    else if (!('summaryRole' in entry)) otherLines.push(line.trim());
    else otherLines.push(line.trim());
  }
  if (dropped > 0) lines.push(`…${dropped} more items below (token budget); scroll or raise maxTokens`);

  const text = lines.join('\n');
  return {
    text,
    elements,
    otherLines,
    meta: {
      url, title,
      viewport: { width: vp.w, height: vp.h },
      scrollPct,
      frameCount: snap.documents.length,
      tokens: estimateTextTokens(text),
    },
  };
}
