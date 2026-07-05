/**
 * M2 bench: a real (small) LLM drives real tasks through Byakugan perception.
 * Reports success, steps, and perception tokens per task, alongside what the
 * same steps would have cost with screenshots / raw DOM / pruned AX tree.
 *
 *   npm run bench            # uses claude CLI with haiku (no API key needed)
 *   BENCH_MODEL=sonnet npm run bench
 */
import { chromium } from 'playwright';
import { Byakugan } from '../src/byakugan.js';
import { fromPlaywright } from '../src/transports/playwright.js';
import { estimateTextTokens, estimateImageTokens } from '../src/tokens.js';
import { runAgent, ClaudeCliLLM } from '../examples/agent.js';

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).href;
const VIEWPORT = { width: 1280, height: 800 };

interface Task {
  name: string;
  page: string;
  task: string;
  verify: (page: import('playwright').Page, answer: string) => Promise<boolean>;
}

const TASKS: Task[] = [
  {
    name: 'checkout-flow',
    page: 'app.html',
    task: "Add the Blue Mug to the cart, open the cart, and place the order. You're done when the page says 'Order placed!'.",
    verify: async (p) => (await p.locator('#status').textContent()) === 'Order placed!',
  },
  {
    name: 'settings-form',
    page: 'app.html',
    task: "Open Settings. Set email to a@b.c, enable the newsletter checkbox, choose the Dark theme, then click Save settings. You're done when the page says 'Saved!'.",
    verify: async (p) => (await p.locator('#status').textContent()) === 'Saved!',
  },
  {
    name: 'blocked-modal',
    page: 'modal.html',
    task: "Click the 'Buy now' button. If something blocks it, deal with the blocker first. You're done when the buy click succeeds.",
    verify: async (p) => (await p.title()) === 'BOUGHT',
  },
  {
    name: 'collapsed-list',
    page: 'list.html',
    task: "Click the link for 'Result item number 13'. It may be inside a collapsed group — collapsed items follow the same order as the visible ones.",
    verify: async (p) => p.url().includes('item/13'),
  },
  {
    name: 'extract-info',
    page: 'app.html',
    task: 'What is the price of the Green Pot? Answer with DONE: <price>.',
    verify: async (_p, answer) => answer.includes('15'),
  },
];

async function main() {
  const model = process.env.BENCH_MODEL ?? 'haiku';
  const llm = new ClaudeCliLLM(model);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const rows: Record<string, string | number>[] = [];

  for (const t of TASKS) {
    const page = await context.newPage();
    await page.goto(fixture(t.page));
    const eyes = await Byakugan.attach(await fromPlaywright(page));

    // Baseline costs for THIS page (what each condition pays per step).
    const rawDomTok = estimateTextTokens(await page.content());
    const shotTok = estimateImageTokens(VIEWPORT.width, VIEWPORT.height);

    console.log(`\n▶ ${t.name}: ${t.task}`);
    const start = Date.now();
    const run = await runAgent(eyes, t.task, llm, { log: (s) => console.log(`   ${s}`) });
    const verified = run.success && (await t.verify(page, run.answer).catch(() => false));

    rows.push({
      task: t.name,
      success: verified ? '✓' : '✗',
      steps: run.steps,
      'byakugan tok': run.perceptionTokens,
      'screenshot tok': shotTok * run.steps,
      'raw DOM tok': rawDomTok * run.steps,
      secs: Math.round((Date.now() - start) / 1000),
    });
    await page.close();
  }
  await browser.close();

  console.log(`\n=== bench results (model: ${model}) — perception tokens per TASK ===\n`);
  console.table(rows);
  const ok = rows.filter((r) => r.success === '✓').length;
  const sum = (k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  console.log(`success: ${ok}/${rows.length}`);
  console.log(`total perception tokens — byakugan: ${sum('byakugan tok')}, screenshots: ${sum('screenshot tok')} (${(sum('screenshot tok') / sum('byakugan tok')).toFixed(1)}x), raw DOM: ${sum('raw DOM tok')} (${(sum('raw DOM tok') / sum('byakugan tok')).toFixed(1)}x)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
