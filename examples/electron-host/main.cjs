/**
 * Minimal Electron host for Byakugan: left window is a normal browser page,
 * right window shows the live manifest + per-step token cost — the same feed
 * an agent would consume. Run `npm start` here; `npm run smoke` auto-quits
 * after the first manifest (CI/verification mode).
 *
 * TS sources are loaded via tsx's CJS register so the demo runs straight from
 * the repo without a build step.
 */
require('tsx/cjs/api').register();
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const SMOKE = !!process.env.BYAKUGAN_SMOKE;

app.whenReady().then(async () => {
  const target = new BrowserWindow({ width: 900, height: 800, x: 40, y: 60, title: 'Target page' });
  await target.loadFile(path.join(__dirname, '../../fixtures/app.html'));

  const panel = new BrowserWindow({
    width: 560, height: 800, x: 960, y: 60, title: 'Byakugan — what the agent sees',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  await panel.loadFile(path.join(__dirname, 'panel.html'));

  const { Byakugan } = require('../../src/index.ts');
  const { fromElectronDebugger } = require('../../src/transports/electron.ts');
  const eyes = await Byakugan.attach(fromElectronDebugger(target.webContents));

  const m = await eyes.observe();
  panel.webContents.send('byakugan', { kind: 'manifest', text: m.text, tokens: m.meta.tokens, elements: m.elements.length });

  if (SMOKE) {
    console.log('SMOKE OK — manifest tokens:', m.meta.tokens, 'elements:', m.elements.length);
    console.log(m.text);
    app.quit();
    return;
  }

  // Live feed: cheap diffs on a short cadence, full text kept in the panel.
  setInterval(async () => {
    try {
      const d = await eyes.diff();
      if (d.text !== 'NO CHANGE') {
        panel.webContents.send('byakugan', {
          kind: d.full ? 'manifest' : 'diff',
          text: d.full ? d.manifest.text : d.text,
          fullText: d.manifest.text,
          tokens: d.tokens,
          elements: d.manifest.elements.length,
        });
      }
    } catch { /* window closing */ }
  }, 1200);

  target.on('closed', () => app.quit());
  panel.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
