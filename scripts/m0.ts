/**
 * M0 — the proof number.
 * For 10 real pages, compare per-step perception token cost:
 *   A. screenshot every step   B. raw DOM   C. pruned AX tree   D. byakugan manifest
 * Manifests and AX dumps are written to m0-output/ for eyeball inspection.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { observe } from '../src/observe.js';
import { fromPlaywright } from '../src/transports/playwright.js';
import { estimateTextTokens, estimateImageTokens } from '../src/tokens.js';

const PAGES = [
  'https://example.com',
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://news.ycombinator.com',
  'https://github.com/microsoft/playwright',
  'https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model',
  'https://duckduckgo.com',
  'https://docs.python.org/3/tutorial/introduction.html',
  'https://playwright.dev',
  'https://www.bbc.com',
  'https://www.wikipedia.org',
];

const VIEWPORT = { width: 1280, height: 800 };
const OUT = new URL('../m0-output/', import.meta.url).pathname;

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  childIds?: string[];
}

/** Condition C: a reasonably pruned AX tree, the strongest common text baseline. */
function serializeAXTree(nodes: AXNode[]): string {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const isChild = new Set(nodes.flatMap((n) => n.childIds ?? []));
  const roots = nodes.filter((n) => !isChild.has(n.nodeId));
  const BORING = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation']);
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = byId.get(id);
    if (!n) return;
    const role = n.role?.value ?? '';
    const name = (n.name?.value ?? '').replace(/\s+/g, ' ').trim();
    let nextDepth = depth;
    if (!n.ignored && !BORING.has(role) && (name || role !== 'StaticText')) {
      lines.push(`${'  '.repeat(Math.min(depth, 8))}${role}${name ? ` "${name.slice(0, 120)}"` : ''}`);
      nextDepth = depth + 1;
    }
    for (const c of n.childIds ?? []) walk(c, nextDepth);
  };
  for (const r of roots) walk(r.nodeId, 0);
  return lines.join('\n');
}

const slug = (url: string) => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9.]+/gi, '-').slice(0, 60);

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const rows: Record<string, string | number>[] = [];

  for (const url of PAGES) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2500); // let SPAs settle

      const cdp = await fromPlaywright(page);
      const manifest = await observe(cdp);

      const rawDom = await page.content();
      const ax = await cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
      const axText = serializeAXTree(ax.nodes);

      await writeFile(`${OUT}${slug(url)}.manifest.txt`, manifest.text);
      await writeFile(`${OUT}${slug(url)}.ax.txt`, axText);

      rows.push({
        page: slug(url),
        'A screenshot': estimateImageTokens(VIEWPORT.width, VIEWPORT.height),
        'B raw DOM': estimateTextTokens(rawDom),
        'C pruned AX': estimateTextTokens(axText),
        'D byakugan': manifest.meta.tokens,
        elements: manifest.elements.length,
      });
      console.log(`✓ ${url} — manifest ${manifest.meta.tokens} tok, ${manifest.elements.length} elements`);
    } catch (err) {
      rows.push({ page: slug(url), error: String(err).split('\n')[0].slice(0, 80) });
      console.log(`✗ ${url} — ${String(err).split('\n')[0]}`);
    } finally {
      await page.close();
    }
  }
  await browser.close();

  const ok = rows.filter((r) => !('error' in r));
  console.log('\n=== M0: perception tokens per step (estimates) ===\n');
  console.table(rows);
  if (ok.length) {
    const avg = (k: string) => Math.round(ok.reduce((s, r) => s + Number(r[k]), 0) / ok.length);
    const a = avg('A screenshot'), b = avg('B raw DOM'), c = avg('C pruned AX'), d = avg('D byakugan');
    console.log(`averages over ${ok.length} pages:`);
    console.log(`  A screenshot : ${a}`);
    console.log(`  B raw DOM    : ${b}  (${(b / d).toFixed(1)}x byakugan)`);
    console.log(`  C pruned AX  : ${c}  (${(c / d).toFixed(1)}x byakugan)`);
    console.log(`  D byakugan   : ${d}  (${(a / d).toFixed(1)}x cheaper than screenshots)`);
    console.log(`\nmanifests written to m0-output/ — read them; would YOU act on this page from that text?`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
