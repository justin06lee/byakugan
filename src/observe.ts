import type { CdpTransport } from './transport.js';
import { estimateTextTokens } from './tokens.js';
import { IdAllocator } from './ids.js';

/**
 * observe(): one DOMSnapshot.captureSnapshot call → filtered, viewport-clipped,
 * render-truthful element manifest. Labels come from painted text runs in the
 * layout tree, never from aria-label/title (pages can spoof those).
 *
 * M0 scope: main document only (no OOPIF stitching), no paint-order occlusion
 * pass (action-time hit-testing is the planned safety net), own-node opacity
 * only. See SPEC.md §4, §8.
 */

const STYLE_KEYS = ['display', 'visibility', 'opacity', 'cursor', 'clip', 'clip-path'];

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'combobox', 'listbox', 'textbox', 'searchbox', 'switch',
  'slider', 'option', 'spinbutton',
]);
const MEDIA_TAGS = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'embed', 'object']);
const HEADING_RE = /^h[1-6]$/;

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
  /** Non-element lines (text, headings-without-records, collapse summaries) for diffing. */
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

interface Item {
  nodeIdx: number;
  kind: 'interactive' | 'media' | 'heading' | 'text';
  role: string;
  label: string;
  extras: string[];
  groupKey: string;
  record?: ElementRecord;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

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
  const vp = { x: vv.pageX, y: vv.pageY, w: vv.clientWidth, h: vv.clientHeight };

  const snap = await cdp.send<any>('DOMSnapshot.captureSnapshot', {
    computedStyles: STYLE_KEYS,
    includePaintOrder: true,
    includeDOMRects: true,
  });
  const strings: string[] = snap.strings;
  const str = (i: number | undefined) => (i !== undefined && i >= 0 ? strings[i] ?? '' : '');
  const doc = snap.documents[0];
  const nodes = doc.nodes;
  const nodeCount: number = nodes.parentIndex.length;

  const tagOf = (i: number) => str(nodes.nodeName[i]).toLowerCase();
  const attrsOf = (i: number): Record<string, string> => {
    const out: Record<string, string> = {};
    const flat: number[] = nodes.attributes[i] ?? [];
    for (let k = 0; k + 1 < flat.length; k += 2) out[str(flat[k])] = str(flat[k + 1]);
    return out;
  };

  const rareBool = (r: any) => new Set<number>(r?.index ?? []);
  const rareStr = (r: any) => {
    const m = new Map<number, string>();
    (r?.index ?? []).forEach((ni: number, k: number) => m.set(ni, str(r.value[k])));
    return m;
  };
  const clickable = rareBool(nodes.isClickable);
  const inputValue = rareStr(nodes.inputValue);
  const inputChecked = rareBool(nodes.inputChecked);

  // Layout tree: the render truth. Nodes absent here produced no layout box.
  interface L { x: number; y: number; w: number; h: number; style: Record<string, string>; text: string }
  const layoutOf = new Map<number, L>();
  const lay = doc.layout;
  for (let li = 0; li < lay.nodeIndex.length; li++) {
    const b = lay.bounds[li];
    const style: Record<string, string> = {};
    STYLE_KEYS.forEach((k, si) => (style[k] = str(lay.styles[li]?.[si])));
    layoutOf.set(lay.nodeIndex[li], {
      x: b[0], y: b[1], w: b[2], h: b[3],
      style,
      text: str(lay.text?.[li]),
    });
  }

  const visible = (i: number): L | null => {
    const l = layoutOf.get(i);
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

  const children: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < nodeCount; i++) {
    const p = nodes.parentIndex[i];
    if (p >= 0) children[p].push(i);
  }

  const consumed = new Uint8Array(nodeCount);
  const consume = (root: number) => {
    const stack = [...children[root]];
    while (stack.length) {
      const n = stack.pop()!;
      consumed[n] = 1;
      stack.push(...children[n]);
    }
  };

  /** Rendered text of a subtree — layout-tree text runs only. */
  const paintedText = (root: number, budget: number): string => {
    let out = '';
    const walk = (n: number) => {
      if (out.length >= budget) return;
      if (nodes.nodeType[n] === 3) {
        const t = squash(layoutOf.get(n)?.text ?? '');
        if (t) out += (out ? ' ' : '') + t;
        return;
      }
      for (const c of children[n]) walk(c);
    };
    for (const c of children[root]) walk(c);
    return clip(squash(out), budget);
  };

  const roleOf = (i: number, t: string, attrs: Record<string, string>): string => {
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

  const isInteractive = (i: number, t: string, attrs: Record<string, string>, l: L): boolean => {
    if (INTERACTIVE_TAGS.has(t)) return (attrs.type ?? '').toLowerCase() !== 'hidden';
    if (INTERACTIVE_ROLES.has((attrs.role ?? '').toLowerCase())) return true;
    if (attrs.contenteditable === 'true' || attrs.contenteditable === '') return true;
    if (attrs.tabindex !== undefined && parseInt(attrs.tabindex, 10) >= 0) return true;
    if (clickable.has(i) && l.style.cursor === 'pointer') return true;
    return false;
  };

  // Single depth-first pass. DOMSnapshot serializes nodes in document order
  // (parents before descendants), so consumption marking works in one sweep.
  const items: Item[] = [];
  const groupKeyOf = (i: number, role: string) => {
    const p = nodes.parentIndex[i];
    const pClass = p >= 0 ? attrsOf(p).class ?? '' : '';
    return `${role}|${attrsOf(i).class ?? ''}|${pClass}`;
  };

  for (let i = 0; i < nodeCount; i++) {
    if (consumed[i]) continue;
    const type = nodes.nodeType[i];

    if (type === 3) {
      const l = visible(i);
      const text = squash(l?.text ?? '');
      if (!text) continue;
      // Pure-punctuation separators ("|", "(", "·") carry no information.
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      let anc = nodes.parentIndex[i];
      while (anc >= 0 && nodes.nodeType[anc] !== 1) anc = nodes.parentIndex[anc];
      const prev = items[items.length - 1];
      if (prev?.kind === 'text' && prev.nodeIdx === anc) {
        prev.label = clip(squash(prev.label + ' ' + text), 300);
      } else {
        items.push({
          nodeIdx: anc, kind: 'text', role: 'text',
          label: clip(text, 300), extras: [],
          groupKey: anc >= 0 ? groupKeyOf(anc, 'text') : 'text',
        });
      }
      continue;
    }

    if (type !== 1) continue;
    const t = tagOf(i);
    if (t === 'script' || t === 'style' || t === 'noscript' || t === 'template') { consume(i); continue; }
    const attrs = attrsOf(i);
    const l = visible(i);
    if (!l) continue; // children may still be visible (overflow); don't consume

    if (HEADING_RE.test(t)) {
      items.push({
        nodeIdx: i, kind: 'heading', role: 'heading',
        label: paintedText(i, 120), extras: [], groupKey: groupKeyOf(i, 'heading'),
      });
      consume(i);
      continue;
    }

    if (isInteractive(i, t, attrs, l)) {
      let role = roleOf(i, t, attrs);
      if (!role) continue;
      const ax = axByBackendId.get(nodes.backendNodeId[i]);
      // Upgrade the generic 'clickable' role using the AX tree's computed role.
      if (role === 'clickable' && ax?.role && INTERACTIVE_ROLES.has(ax.role.toLowerCase())) {
        role = ax.role.toLowerCase();
      }
      let label = paintedText(i, 100);
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
      if ((t === 'input' || t === 'textarea' || role === 'combobox') && role !== 'checkbox' && role !== 'radio') {
        const v = inputValue.get(i);
        if (v) extras.push(`value=${JSON.stringify(clip(v, 60))}`);
        if (attrs.placeholder) extras.push(`placeholder=${JSON.stringify(clip(attrs.placeholder, 60))}`);
      }
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        extras.push(inputChecked.has(i) ? 'checked' : 'unchecked');
      }
      if (attrs.disabled !== undefined || attrs['aria-disabled'] === 'true') extras.push('disabled');
      items.push({ nodeIdx: i, kind: 'interactive', role, label, extras, groupKey: groupKeyOf(i, role) });
      consume(i);
      continue;
    }

    if (MEDIA_TAGS.has(t)) {
      const label = t === 'img' ? clip(squash(attrs.alt ?? ''), 80) : '';
      const size = `${Math.round(l.w)}x${Math.round(l.h)}`;
      const extras = [size];
      if (t === 'canvas' || t === 'video' || t === 'iframe') extras.push('text-blind; use look(id)');
      // Tiny decorative images/icons aren't worth a line each.
      if (t === 'img' && l.w * l.h < 2000 && !label) { consume(i); continue; }
      if (t === 'svg') { consume(i); continue; } // icons; painted text inside is rare
      items.push({ nodeIdx: i, kind: 'media', role: t, label, extras, groupKey: groupKeyOf(i, t) });
      consume(i);
      continue;
    }
  }

  // Repetition collapse: runs of ≥5 consecutive same-shaped items keep 3.
  const collapsed: (Item | { summary: string })[] = [];
  let run: Item[] = [];
  const flushRun = () => {
    if (run.length >= 5) {
      collapsed.push(...run.slice(0, 3));
      collapsed.push({ summary: `…and ${run.length - 3} more similar ${run[0].role}${run.length - 3 > 1 ? 's' : ''}` });
    } else {
      collapsed.push(...run);
    }
    run = [];
  };
  for (const it of items) {
    if (run.length && (it.groupKey !== run[0].groupKey || it.kind !== run[0].kind)) flushRun();
    run.push(it);
  }
  flushRun();

  // Render with ID assignment and hard token budget (announced truncation).
  const url = str(doc.documentURL);
  const title = str(doc.title);
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
    if ('summary' in entry) {
      line = `     ${entry.summary}`;
    } else if (entry.kind === 'text') {
      line = `     ${JSON.stringify(entry.label)}`;
    } else {
      const backendNodeId = nodes.backendNodeId[entry.nodeIdx];
      const id = ids.idFor(backendNodeId);
      const parts = [`[${id}]`, entry.role];
      if (entry.label || entry.kind === 'interactive') parts.push(JSON.stringify(entry.label));
      parts.push(...entry.extras);
      line = parts.join(' ');
      const l = layoutOf.get(entry.nodeIdx)!;
      record = {
        id, backendNodeId, role: entry.role, label: entry.label,
        bounds: { x: l.x, y: l.y, w: l.w, h: l.h },
        line,
      };
    }
    const cost = estimateTextTokens(line) + 1;
    if (budgetUsed + cost > maxTokens - 15) { dropped++; continue; }
    budgetUsed += cost;
    lines.push(line);
    if (record) elements.push(record);
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
