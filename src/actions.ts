import type { CdpTransport } from './transport.js';
import type { ElementRecord } from './observe.js';

/**
 * Verified input dispatch. Every element action re-resolves geometry at call
 * time and hit-tests the target point: if another node (modal, overlay) is
 * topmost and unrelated, the action returns a structured failure instead of
 * clicking through — the safety net for perception's occlusion approximation.
 * Events go through Input.dispatch* (browser-level), not synthetic JS events.
 */

export type ActionResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string; blockedBy?: string };

interface Resolver {
  resolve(id: number): ElementRecord;
}

const KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
};

export class Actions {
  constructor(private cdp: CdpTransport, private perception: Resolver) {}

  /** Fresh viewport-relative center point, scrolling the node into view if needed. */
  private async centerOf(backendNodeId: number): Promise<{ x: number; y: number }> {
    const quads = async () => {
      const r = await this.cdp.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId });
      return r.quads?.[0];
    };
    let q = await quads().catch(() => undefined);
    if (!q) {
      await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
      q = await quads();
    }
    if (!q) throw new Error('element has no visible geometry');
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    // Point must be inside the viewport for getNodeForLocation and input.
    const metrics = await this.cdp.send<any>('Page.getLayoutMetrics');
    const vv = metrics.cssVisualViewport;
    if (x < 0 || y < 0 || x > vv.clientWidth || y > vv.clientHeight) {
      await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
      return this.centerOfNoScroll(backendNodeId);
    }
    return { x, y };
  }

  private async centerOfNoScroll(backendNodeId: number): Promise<{ x: number; y: number }> {
    const r = await this.cdp.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId });
    const q = r.quads?.[0];
    if (!q) throw new Error('element has no visible geometry');
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }

  /**
   * Is the node actually topmost at (x, y)? Related nodes (ancestor/descendant,
   * e.g. a <span> inside the button) count as hits.
   */
  private async hitTest(backendNodeId: number, x: number, y: number): Promise<{ hit: boolean; blocker?: string }> {
    let topId: number;
    try {
      // getContentQuads is viewport-relative but getNodeForLocation expects
      // document coordinates — on a scrolled page the unadjusted point lands on
      // whatever sits N-scrolled-pixels above and falsely reports "blocked".
      let px = x, py = y;
      try {
        const metrics = await this.cdp.send<any>('Page.getLayoutMetrics');
        px += metrics.cssVisualViewport.pageX;
        py += metrics.cssVisualViewport.pageY;
      } catch { /* no metrics — fall back to unadjusted (correct at scroll 0) */ }
      const r = await this.cdp.send<{ backendNodeId: number }>('DOM.getNodeForLocation', {
        x: Math.round(px), y: Math.round(py), includeUserAgentShadowDOM: false,
      });
      topId = r.backendNodeId;
    } catch {
      return { hit: true }; // no node at point info — don't block the action on it
    }
    if (topId === backendNodeId) return { hit: true };
    try {
      const a = await this.cdp.send<any>('DOM.resolveNode', { backendNodeId });
      const b = await this.cdp.send<any>('DOM.resolveNode', { backendNodeId: topId });
      const rel = await this.cdp.send<any>('Runtime.callFunctionOn', {
        objectId: a.object.objectId,
        functionDeclaration: 'function(o){ return this.contains(o) || o.contains(this); }',
        arguments: [{ objectId: b.object.objectId }],
        returnByValue: true,
      });
      if (rel.result?.value === true) return { hit: true };
    } catch { /* fall through to blocked */ }
    let blocker = 'another element';
    try {
      const d = await this.cdp.send<any>('DOM.describeNode', { backendNodeId: topId });
      const n = d.node;
      const attrs: string[] = n.attributes ?? [];
      const get = (name: string) => { const i = attrs.indexOf(name); return i >= 0 ? attrs[i + 1] : ''; };
      blocker = n.nodeName.toLowerCase() +
        (get('id') ? `#${get('id')}` : '') +
        (get('class') ? `.${get('class').split(/\s+/).slice(0, 2).join('.')}` : '');
    } catch { /* generic blocker label */ }
    return { hit: false, blocker };
  }

  async click(id: number): Promise<ActionResult> {
    try {
      const el = this.perception.resolve(id);
      const { x, y } = await this.centerOf(el.backendNodeId);
      const ht = await this.hitTest(el.backendNodeId, x, y);
      if (!ht.hit) {
        return { ok: false, error: `click(${id}) blocked: point is covered by <${ht.blocker}>`, blockedBy: ht.blocker };
      }
      const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `click(${id}): ${msg(e)}` };
    }
  }

  async type(id: number, text: string): Promise<ActionResult> {
    try {
      const el = this.perception.resolve(id);
      const desc = await this.cdp.send<any>('DOM.describeNode', { backendNodeId: el.backendNodeId }).catch(() => null);
      if (desc?.node?.nodeName === 'SELECT') {
        return { ok: false, error: `type(${id}): this is a dropdown — use select(${id}, "<option text>") instead` };
      }
      await this.cdp.send('DOM.focus', { backendNodeId: el.backendNodeId });
      // Replace existing content: select-all semantics for editable fields.
      const r = await this.cdp.send<any>('DOM.resolveNode', { backendNodeId: el.backendNodeId });
      await this.cdp.send('Runtime.callFunctionOn', {
        objectId: r.object.objectId,
        functionDeclaration: 'function(){ if (this.select) this.select(); }',
      }).catch(() => {});
      await this.cdp.send('Input.insertText', { text });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `type(${id}): ${msg(e)}` };
    }
  }

  async press(key: string): Promise<ActionResult> {
    const k = KEY_MAP[key];
    if (!k) return { ok: false, error: `press: unsupported key "${key}" (supported: ${Object.keys(KEY_MAP).join(', ')})` };
    const common = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    if (k.text) await this.cdp.send('Input.dispatchKeyEvent', { type: 'char', text: k.text, ...common });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    return { ok: true };
  }

  async scroll(target: 'up' | 'down' | number): Promise<ActionResult> {
    try {
      if (typeof target === 'number') {
        const el = this.perception.resolve(target);
        await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId });
        return { ok: true };
      }
      const metrics = await this.cdp.send<any>('Page.getLayoutMetrics');
      const vv = metrics.cssVisualViewport;
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: vv.clientWidth / 2, y: vv.clientHeight / 2,
        deltaX: 0, deltaY: target === 'down' ? vv.clientHeight * 0.8 : -vv.clientHeight * 0.8,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `scroll: ${msg(e)}` };
    }
  }

  async select(id: number, value: string): Promise<ActionResult> {
    try {
      const el = this.perception.resolve(id);
      const r = await this.cdp.send<any>('DOM.resolveNode', { backendNodeId: el.backendNodeId });
      const res = await this.cdp.send<any>('Runtime.callFunctionOn', {
        objectId: r.object.objectId,
        functionDeclaration: `function(v){
          const opts = Array.from(this.options ?? []);
          const o = opts.find(o => o.textContent.trim() === v || o.value === v);
          if (!o) return { ok: false, have: opts.map(o => o.textContent.trim()) };
          this.value = o.value;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }`,
        arguments: [{ value }],
        returnByValue: true,
      });
      const v = res.result?.value;
      if (!v?.ok) return { ok: false, error: `select(${id}, "${value}"): no such option; options are ${JSON.stringify(v?.have ?? [])}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `select(${id}): ${msg(e)}` };
    }
  }

  async hover(id: number): Promise<ActionResult> {
    try {
      const el = this.perception.resolve(id);
      const { x, y } = await this.centerOf(el.backendNodeId);
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `hover(${id}): ${msg(e)}` };
    }
  }

  async navigate(url: string): Promise<ActionResult> {
    try {
      await this.cdp.send('Page.navigate', { url });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `navigate: ${msg(e)}` };
    }
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
