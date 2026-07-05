/**
 * The only thing Byakugan needs from a host: a CDP connection.
 * Electron's webContents.debugger, Playwright's CDPSession, Puppeteer's
 * CDPSession, and a raw devtools WebSocket can all satisfy this.
 */
export interface CdpTransport {
  send<T = unknown>(method: string, params?: object): Promise<T>;
  on(event: string, cb: (params: unknown) => void): void;
  detach(): Promise<void>;
}
