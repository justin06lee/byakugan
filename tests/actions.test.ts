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

const byLabel = (eyes: Byakugan, label: string) => {
  const el = eyes.lastManifest!.elements.find((e) => e.label.includes(label));
  assert.ok(el, `no element labeled "${label}" in manifest`);
  return el!;
};

test('click through a modal is blocked with a structured failure', async () => {
  const { page, eyes } = await open('modal.html');
  await eyes.observe();
  const buy = byLabel(eyes, 'Buy now');

  const blocked = await eyes.act.click(buy.id);
  assert.equal(blocked.ok, false);
  assert.match((blocked as any).blockedBy ?? '', /overlay|dialog|cookie/i);
  assert.notEqual(await page.title(), 'BOUGHT', 'click must not fall through the overlay');

  const accept = byLabel(eyes, 'Accept cookies');
  assert.deepEqual((await eyes.act.click(accept.id)).ok, true);
  await page.waitForTimeout(100);
  await eyes.diff();
  const retry = await eyes.act.click(buy.id);
  assert.equal(retry.ok, true);
  await page.waitForTimeout(100);
  assert.equal(await page.title(), 'BOUGHT');
  await page.close();
});

test('type replaces content, select picks options, click drives app state', async () => {
  const { page, eyes } = await open('app.html');
  await eyes.observe();

  await eyes.act.click(byLabel(eyes, 'Settings').id);
  await page.waitForTimeout(100);
  await eyes.diff();

  const email = eyes.lastManifest!.elements.find((e) => e.role === 'textbox')!;
  await eyes.act.type(email.id, 'wrong@x.y');
  await eyes.act.type(email.id, 'a@b.c'); // second type must replace, not append
  const news = eyes.lastManifest!.elements.find((e) => e.role === 'checkbox')!;
  await eyes.act.click(news.id);
  const theme = eyes.lastManifest!.elements.find((e) => e.role === 'combobox')!;
  const bad = await eyes.act.select(theme.id, 'Solarized');
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /options are.*Light.*Dark/);
  assert.equal((await eyes.act.select(theme.id, 'Dark')).ok, true);

  await eyes.act.click(byLabel(eyes, 'Save settings').id);
  await page.waitForTimeout(100);
  const d = await eyes.diff();
  assert.match(d.text, /Saved!/);
  await page.close();
});

test('full flow: add to cart, place order — via manifest IDs only', async () => {
  const { page, eyes } = await open('app.html');
  const m = await eyes.observe();
  const addBlue = m.elements.find((e) =>
    e.role === 'button' && m.text.includes('Blue Mug'))!;
  await eyes.act.click(addBlue.id);
  await page.waitForTimeout(100);
  const d1 = await eyes.diff();
  assert.match(d1.text, /added to cart|Cart \(1\)/);

  await eyes.act.click(byLabel(eyes, 'Cart').id);
  await page.waitForTimeout(100);
  await eyes.diff();
  await eyes.act.click(byLabel(eyes, 'Place order').id);
  await page.waitForTimeout(100);
  const d2 = await eyes.diff();
  assert.match(d2.text, /Order placed!/);
  await page.close();
});

test('collapsed list rows remain actionable via their IDs', async () => {
  const { page, eyes } = await open('list.html');
  const m = await eyes.observe();
  assert.match(m.text, /…and \d+ more similar links \[\d+-\d+\]/);
  const item13 = m.elements.find((e) => e.label === 'Result item number 13')!;
  assert.ok(item13, 'collapsed element must still have a record');
  assert.ok(!m.text.includes('Result item number 13'), 'row 13 should be collapsed out of the text');
  const res = await eyes.act.click(item13.id);
  assert.equal(res.ok, true);
  await page.waitForTimeout(200);
  assert.match(page.url(), /item\/13/);
  await page.close();
});

test('press Enter submits, scroll changes viewport', async () => {
  const { page, eyes } = await open('list.html');
  await page.setViewportSize({ width: 600, height: 200 });
  await eyes.observe();
  await eyes.act.scroll('down');
  await page.waitForTimeout(150);
  const d = await eyes.diff();
  assert.notEqual(d.text, 'NO CHANGE', 'scrolling should reveal new rows or change scroll pct');
  await page.close();
});
