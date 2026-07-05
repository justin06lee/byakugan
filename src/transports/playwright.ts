import type { Page } from 'playwright';
import type { CdpTransport } from '../transport.js';

export async function fromPlaywright(page: Page): Promise<CdpTransport> {
  const session = await page.context().newCDPSession(page);
  return {
    send: <T>(method: string, params?: object) =>
      session.send(method as Parameters<typeof session.send>[0], params) as Promise<T>,
    on: (event, cb) => session.on(event as Parameters<typeof session.on>[0], cb),
    detach: () => session.detach(),
  };
}
