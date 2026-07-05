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

test('basic: interactive elements with painted labels and states', async () => {
  const { page, eyes } = await open('basic.html');
  const m = await eyes.observe();
  assert.match(m.text, /heading "Account Settings"/);
  assert.match(m.text, /button "Save changes"/);
  assert.match(m.text, /link "Help center"/);
  assert.match(m.text, /textbox .*placeholder="you@example\.com"/);
  assert.match(m.text, /checkbox .*unchecked/);
  assert.match(m.text, /combobox/);
  assert.match(m.text, /canvas .*look/);
  assert.ok(m.meta.tokens < 200, `basic fixture should be tiny, got ${m.meta.tokens}`);
  await page.close();
});

test('basic: icon-only button falls back to AX name, marked (aria)', async () => {
  const { page, eyes } = await open('basic.html');
  const m = await eyes.observe();
  assert.match(m.text, /button "✕" \(aria "Close dialog"\)/);
  await page.close();
});

test('hidden: invisible and off-screen content never enters the manifest', async () => {
  const { page, eyes } = await open('hidden.html');
  const m = await eyes.observe();
  for (const secret of ['SECRET-DISPLAY-NONE', 'SECRET-VISIBILITY', 'SECRET-OPACITY',
                        'SECRET-SRONLY', 'SECRET-CLIPPATH', 'SECRET-OFFSCREEN']) {
    assert.ok(!m.text.includes(secret), `leaked: ${secret}`);
  }
  assert.match(m.text, /Normal visible text/);
  await page.close();
});

test('hidden: painted label beats spoofed aria-label', async () => {
  const { page, eyes } = await open('hidden.html');
  const m = await eyes.observe();
  assert.match(m.text, /button "Pay \$5"/);
  assert.ok(!m.text.includes('$500'), 'spoofed aria-label leaked into manifest');
  await page.close();
});

test('list: repeated rows collapse', async () => {
  const { page, eyes } = await open('list.html');
  const m = await eyes.observe();
  assert.match(m.text, /Result item number 1/);
  assert.match(m.text, /…and \d+ more similar/);
  assert.ok(!m.text.includes('Result item number 15'), 'collapse did not drop mid-list rows');
  await page.close();
});

test('diff: no change → NO CHANGE; mutation → compact +/~ lines with stable IDs', async () => {
  const { page, eyes } = await open('dynamic.html');
  const m1 = await eyes.observe();
  const counterId = m1.elements.find((e) => e.label.startsWith('Count:'))!.id;

  const d0 = await eyes.diff();
  assert.equal(d0.text, 'NO CHANGE');
  assert.ok(d0.tokens < 10);

  await page.click('#inc');
  const d1 = await eyes.diff();
  assert.ok(!d1.full);
  assert.match(d1.text, new RegExp(`~ \\[${counterId}\\] button "Count: 1"`));
  assert.ok(d1.tokens < 30, `diff should be tiny, got ${d1.tokens}`);

  await page.click('#spawn');
  const d2 = await eyes.diff();
  assert.match(d2.text, /\+ \[\d+\] link "Limited time offer"/);
  const counterNow = d2.manifest.elements.find((e) => e.label.startsWith('Count:'))!.id;
  assert.equal(counterNow, counterId, 'IDs must be stable across steps');
  await page.close();
});

test('diff: navigation forces full re-observe with fresh IDs', async () => {
  const { page, eyes } = await open('dynamic.html');
  await eyes.observe();
  await page.goto(fixture('basic.html'));
  const d = await eyes.diff();
  assert.ok(d.full);
  assert.match(d.text, /NAVIGATED/);
  assert.match(d.text, /Account Settings/);
  const minId = Math.min(...d.manifest.elements.map((e) => e.id));
  assert.equal(minId, 1, 'ID allocator should reset on navigation');
  await page.close();
});

test('look: cropped screenshot of an element is a small PNG', async () => {
  const { page, eyes } = await open('basic.html');
  const m = await eyes.observe();
  const canvas = m.elements.find((e) => e.role === 'canvas')!;
  const shot = await eyes.look(canvas.id);
  assert.ok(shot.data.length > 100, 'png should be non-trivial');
  assert.equal(shot.data.subarray(1, 4).toString(), 'PNG');
  assert.ok(shot.tokens < 700, `cropped look should be cheap, got ${shot.tokens}`);
  assert.ok(shot.width >= 300 && shot.width <= 340, `unexpected crop width ${shot.width}`);
  await page.close();
});
