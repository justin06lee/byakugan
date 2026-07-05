import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { Byakugan } from '../src/byakugan.js';
import { fromPlaywright } from '../src/transports/playwright.js';

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).href;

let browser: Browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

async function open(name: string): Promise<{ page: Page; eyes: Byakugan }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(fixture(name));
  const eyes = await Byakugan.attach(await fromPlaywright(page));
  return { page, eyes };
}

test('occlusion: content under an opaque panel is dropped; panel contents and peeking elements stay', async () => {
  const { page, eyes } = await open('occlusion.html');
  const m = await eyes.observe();
  assert.ok(!m.text.includes('Hidden under panel'), 'fully covered button leaked into manifest');
  assert.match(m.text, /button "Panel button"/);
  assert.match(m.text, /heading "Opaque panel"/);
  assert.match(m.text, /link "Peeking out"/);
  await page.close();
});

test('iframe: same-process frame content is stitched in and actionable', async () => {
  const { page, eyes } = await open('iframe.html');
  const m = await eyes.observe();
  assert.match(m.text, /button "Parent button"/);
  assert.match(m.text, /heading "Inside the frame"/);
  assert.match(m.text, /button "Frame button"/);
  assert.match(m.text, /link "Frame link"/);
  assert.ok(m.meta.frameCount >= 2);

  const frameBtn = m.elements.find((e) => e.label === 'Frame button')!;
  // Stitched coordinates: the frame button must sit inside the iframe's box on screen.
  const box = await page.locator('#child').boundingBox();
  assert.ok(frameBtn.bounds.y > box!.y, 'frame content coords must be offset into the iframe box');
  const res = await eyes.act.click(frameBtn.id);
  assert.equal(res.ok, true, `frame click failed: ${JSON.stringify(res)}`);
  await page.waitForTimeout(150);
  const d = await eyes.diff();
  assert.match(d.text, /frame clicked!/);
  await page.close();
});

test('select: manifest exposes options and current value', async () => {
  const { page, eyes } = await open('basic.html');
  const m = await eyes.observe();
  assert.match(m.text, /combobox .*value="Light" options=\["Light","Dark"\]/);
  await page.close();
});

test('type on a select fails with guidance toward select()', async () => {
  const { page, eyes } = await open('basic.html');
  const m = await eyes.observe();
  const theme = m.elements.find((e) => e.role === 'combobox')!;
  const res = await eyes.act.type(theme.id, 'Dark');
  assert.equal(res.ok, false);
  assert.match((res as any).error, /use select\(/);
  await page.close();
});
