import type { CdpTransport } from '../transport.js';

/**
 * Raw DevTools WebSocket adapter (Node ≥22 global WebSocket, zero deps).
 * Pass a PAGE target's ws URL, e.g. ws://127.0.0.1:9222/devtools/page/<id> —
 * discover it via http://127.0.0.1:9222/json/list.
 */
export function fromWebSocket(wsUrl: string): Promise<CdpTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const listeners = new Map<string, Set<(params: unknown) => void>>();
    let nextId = 1;

    ws.onopen = () => resolve({
      send: <T>(method: string, params?: object) => new Promise<T>((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      }),
      on: (event, cb) => {
        let set = listeners.get(event);
        if (!set) listeners.set(event, (set = new Set()));
        set.add(cb);
      },
      detach: async () => ws.close(),
    });
    ws.onerror = () => reject(new Error(`WebSocket connection failed: ${wsUrl}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (!p) return;
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        listeners.get(msg.method)?.forEach((cb) => cb(msg.params));
      }
    };
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('CDP WebSocket closed'));
      pending.clear();
    };
  });
}
