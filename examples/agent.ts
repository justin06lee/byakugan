/**
 * Example agent loop over Byakugan perception. NOT part of the library core —
 * it exists to prove the perception layer drives real task completion and to
 * power the benchmark. The LLM is pluggable: Anthropic API or the Claude Code
 * CLI in print mode (no API key needed).
 */
import { spawn } from 'node:child_process';
import type { Byakugan } from '../src/byakugan.js';
import { estimateTextTokens } from '../src/tokens.js';

export interface LLM {
  complete(prompt: string): Promise<string>;
  name: string;
}

/** Claude Code CLI as a headless, tool-less LLM. Stateless per call. */
export class ClaudeCliLLM implements LLM {
  name: string;
  constructor(private model: string = 'haiku') { this.name = `claude-cli:${model}`; }
  complete(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('claude',
        ['-p', '--model', this.model, '--tools', '', '--no-session-persistence'],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
      let out = '', err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 300)}`)));
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

/** Direct Anthropic API (used when ANTHROPIC_API_KEY is set). */
export class AnthropicApiLLM implements LLM {
  name: string;
  constructor(private model: string = 'claude-haiku-4-5-20251001', private apiKey = process.env.ANTHROPIC_API_KEY) {
    this.name = `api:${model}`;
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  }
  async complete(prompt: string): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    return data.content[0].text.trim();
  }
}

const SYSTEM = `You are a browser agent. You perceive the page as a text manifest:
each line is "[id] role \\"label\\" extras". Lines starting with +/-/~ are changes
since your last action. Collapsed rows like "…and 17 more similar links [24-40]"
are real elements you can act on by id (they follow the pattern of the rows above).

Respond with EXACTLY ONE line, nothing else:
  ACTION: click(<id>)
  ACTION: type(<id>, "<text>")
  ACTION: select(<id>, "<option text>")
  ACTION: press("<Enter|Tab|Escape|ArrowDown|...>")
  ACTION: scroll("<up|down>")
  DONE: <your answer / confirmation the task is complete>

Rules: act on what the manifest shows; if an action reports "blocked", deal with
the blocker first. Say DONE only when the observation proves the task succeeded.`;

export interface AgentRunResult {
  success: boolean;
  answer: string;
  steps: number;
  perceptionTokens: number;
  transcript: string;
}

export async function runAgent(
  eyes: Byakugan,
  task: string,
  llm: LLM,
  opts: { maxSteps?: number; settleMs?: number; log?: (s: string) => void } = {},
): Promise<AgentRunResult> {
  const maxSteps = opts.maxSteps ?? 12;
  const settle = opts.settleMs ?? 400;
  const log = opts.log ?? (() => {});
  let transcript = '';
  let perceptionTokens = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const obs = step === 1 ? (await eyes.observe()).text : (await eyes.diff()).text;
    perceptionTokens += estimateTextTokens(obs);
    transcript += `\nOBSERVATION ${step}:\n${obs}\n`;

    const reply = await llm.complete(`${SYSTEM}\n\nTASK: ${task}\n${transcript}\nYour next line:`);
    transcript += `AGENT: ${reply}\n`;
    log(`step ${step}: ${reply}`);

    const done = reply.match(/^DONE:\s*(.*)/m);
    if (done) return { success: true, answer: done[1].trim(), steps: step, perceptionTokens, transcript };

    const action = reply.match(/^ACTION:\s*(\w+)\(([^)]*)\)/m);
    if (!action) {
      transcript += `RESULT: unparseable reply — respond with exactly one ACTION or DONE line\n`;
      continue;
    }
    const [, verb, rawArgs] = action;
    const result = await dispatch(eyes, verb, rawArgs);
    transcript += `RESULT: ${result}\n`;
    log(`  → ${result}`);
    await new Promise((r) => setTimeout(r, settle));
  }
  return { success: false, answer: '(step limit reached)', steps: maxSteps, perceptionTokens, transcript };
}

async function dispatch(eyes: Byakugan, verb: string, rawArgs: string): Promise<string> {
  const args = parseArgs(rawArgs);
  try {
    switch (verb) {
      case 'click': return fmt(await eyes.act.click(num(args[0])));
      case 'type': return fmt(await eyes.act.type(num(args[0]), String(args[1] ?? '')));
      case 'select': return fmt(await eyes.act.select(num(args[0]), String(args[1] ?? '')));
      case 'press': return fmt(await eyes.act.press(String(args[0] ?? '')));
      case 'hover': return fmt(await eyes.act.hover(num(args[0])));
      case 'scroll': {
        const t = args[0];
        return fmt(await eyes.act.scroll(typeof t === 'number' ? t : (String(t) as 'up' | 'down')));
      }
      case 'navigate': return fmt(await eyes.act.navigate(String(args[0] ?? '')));
      default: return `error: unknown action "${verb}"`;
    }
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function parseArgs(raw: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d+)?)|([A-Za-z][\w-]*)/g;
  let m;
  while ((m = re.exec(raw))) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, '$1'));
    else if (m[2] !== undefined) out.push(m[2].replace(/\\(.)/g, '$1'));
    else if (m[3] !== undefined) out.push(Number(m[3]));
    else out.push(m[4]);
  }
  return out;
}

const num = (v: string | number | undefined): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) throw new Error(`expected an element id, got "${v}"`);
  return n;
};

const fmt = (r: { ok: boolean } & Record<string, unknown>): string =>
  r.ok ? 'ok' : `FAILED: ${r.error}${r.blockedBy ? ` (blocked by ${r.blockedBy})` : ''}`;
