import type { CdpTransport } from '../transport.js';

/**
 * Electron host adapter: CDP over webContents.debugger. Typed structurally so
 * the library has no dependency on electron itself — pass any object with a
 * matching `debugger` property (i.e. a real WebContents).
 */
interface ElectronDebugger {
  attach(protocolVersion?: string): void;
  isAttached(): boolean;
  detach(): void;
  sendCommand(method: string, commandParams?: object): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown;
}

export interface WebContentsLike {
  debugger: ElectronDebugger;
}

export function fromElectronDebugger(webContents: WebContentsLike): CdpTransport {
  const dbg = webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  dbg.on('message', (_event, method, params) => {
    listeners.get(method)?.forEach((cb) => cb(params));
  });
  return {
    send: <T>(method: string, params?: object) => dbg.sendCommand(method, params) as Promise<T>,
    on: (event, cb) => {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(cb);
    },
    detach: async () => { if (dbg.isAttached()) dbg.detach(); },
  };
}
