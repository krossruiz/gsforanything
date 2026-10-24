// The custom Scene chat prompt reaches the LLM call, in server.js and in the
// Cloudflare Worker, with the LLM mocked (no real API calls):
//   node upstream.mjs
//   WORKER_BASE=http://127.0.0.1:8797 node upstream.mjs   # also check a running wrangler dev
// server.js runs with fake keys and mock-llm-https.mjs preloaded (captures the
// api.anthropic.com / api.openai.com request bodies). worker/index.js runs in
// Node with a fake env and a mocked fetch that captures its upstream calls.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the local server's self-signed cert
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const results = [];
const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n}${e && !c ? ' — ' + e : ''}`); console.log(results.at(-1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const prompts = await import(pathToFileURL(path.join(ROOT, 'worker/prompts.js')).href);
const CUSTOM = 'You are a terse scene builder.\n## House style\nAlways add a brass plaque.';
const EXPECT = `${CUSTOM}\n\n${prompts.CHAT_PROMPT_REQUIRED}`;
const msgs = [{ role: 'user', content: 'a red cube' }];

// The generated Worker prompts match server.js.
{
  const src = fs.readFileSync(path.join(ROOT, 'site-source/server.js'), 'utf8');
  ok('worker/prompts.js is up to date with server.js (SYSTEM_PROMPT has the lighting section)', /## Photorealistic lighting and materials/.test(prompts.SYSTEM_PROMPT) && src.includes('MAX_CUSTOM_PROMPT_CHARS = ' + prompts.MAX_CUSTOM_PROMPT_CHARS + ';') && /GS technical requirements/.test(prompts.CHAT_PROMPT_REQUIRED));
}

async function scenario(H, base, captured) {
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const pr = await (await fetch(base + '/api/prompts')).json();
  ok(`${H} /api/prompts: systemPrompt, chatPromptRequired, maxCustomPromptChars`, pr.systemPrompt === prompts.SYSTEM_PROMPT && pr.chatPromptRequired === prompts.CHAT_PROMPT_REQUIRED && pr.maxCustomPromptChars === 40000 && pr.fixCodePrompt === prompts.FIX_CODE_PROMPT && pr.themePrompt === prompts.THEME_SYSTEM_PROMPT);
  const cases = [
    ['claude-sonnet-55', 'api.anthropic.com', (b) => b.system],
    ['openai-sol', 'api.openai.com', (b) => b.messages[0].role === 'system' && b.messages[0].content]
  ];
  for (const [backend, host, sys] of cases) {
    let n = captured().length;
    let r = await post('/api/chat', { messages: msgs, backend });
    let c = captured().slice(n);
    ok(`${H} ${backend}: no systemPrompt → default SYSTEM_PROMPT upstream`, r.status === 200 && c.length === 1 && c[0].host === host && sys(c[0].body) === prompts.SYSTEM_PROMPT, `${r.status} ${JSON.stringify(r.json).slice(0, 120)} ${c.length}`);
    n = captured().length;
    r = await post('/api/chat', { messages: msgs, backend, systemPrompt: CUSTOM });
    c = captured().slice(n);
    ok(`${H} ${backend}: custom systemPrompt → custom + required section upstream`, r.status === 200 && c.length === 1 && sys(c[0].body) === EXPECT, `${r.status} ${c.length} ${String(c[0] && sys(c[0].body)).slice(0, 80)}`);
    ok(`${H} ${backend}: messages pass through unchanged`, JSON.stringify(c[0]?.body.messages.filter(m => m.role !== 'system')) === JSON.stringify(msgs));
  }
  let n = captured().length;
  let r = await post('/api/chat', { messages: msgs, backend: 'claude-sonnet-55', systemPrompt: '   \n ' });
  ok(`${H} blank systemPrompt → default`, r.status === 200 && captured().slice(n)[0]?.body.system === prompts.SYSTEM_PROMPT);
  n = captured().length;
  r = await post('/api/chat', { messages: msgs, backend: 'claude-sonnet-55', systemPrompt: 'x'.repeat(40001) });
  ok(`${H} over 40,000 chars → 400, no upstream call`, r.status === 400 && /too long/.test(r.json?.error || '') && captured().length === n, JSON.stringify(r.json));
  r = await post('/api/chat', { messages: msgs, backend: 'claude-sonnet-55', systemPrompt: 'x'.repeat(40000) });
  ok(`${H} exactly 40,000 chars is accepted`, r.status === 200);
  n = captured().length;
  r = await post('/api/chat', { messages: msgs, backend: 'claude-sonnet-55', systemPrompt: { evil: 1 } });
  ok(`${H} non-string systemPrompt → 400, no upstream call`, r.status === 400 && captured().length === n);
  n = captured().length;
  r = await post('/api/theme-chat', { messages: msgs, backend: 'claude-sonnet-55', systemPrompt: CUSTOM });
  ok(`${H} /api/theme-chat ignores systemPrompt (theme prompt)`, r.status === 200 && captured().slice(n)[0]?.body.system === prompts.THEME_SYSTEM_PROMPT);
  n = captured().length;
  r = await post('/api/fix-code', { failingCode: 'x(', errorMessage: 'SyntaxError', backend: 'claude-sonnet-55', systemPrompt: CUSTOM });
  ok(`${H} /api/fix-code ignores systemPrompt (fix prompt)`, r.status === 200 && captured().slice(n)[0]?.body.system === prompts.FIX_CODE_PROMPT);
}

// ---------------------------------------------------------------- server.js
{
  const CAP = `/tmp/gs-llm-capture-${process.pid}.jsonl`;
  fs.writeFileSync(CAP, '');
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(HERE, 'mock-llm-https.mjs')).href, 'server.js'], {
    cwd: path.join(ROOT, 'site-source'),
    env: { ...process.env, PORT: String(port), CLAUDE_API_KEY: 'fake-claude', OPENAI_API_KEY: 'fake-openai', ANTHROPIC_API_KEY: '', GS_LLM_CAPTURE: CAP },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  const base = `https://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/prompts'); break; } catch { await sleep(250); } }
  try {
    await scenario('[server.js]', base, () => fs.readFileSync(CAP, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
  } catch (e) { ok('[server.js] scenario ran', false, e.stack + '\n' + log.slice(-800)); }
  child.kill();
  fs.rmSync(CAP, { force: true });
}

// ---------------------------------------------------------------- Worker
// worker/index.js runs in Node with a fake env and a mocked global fetch for
// the two LLM hosts (anything else fails the test). The real workerd run is
// covered by the share suite and the wrangler dev smoke check below.
{
  const cap = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.hostname !== 'api.anthropic.com' && u.hostname !== 'api.openai.com') throw new Error('unexpected outbound fetch ' + req.url);
    cap.push({ host: u.hostname, path: u.pathname, body: await req.json() });
    const reply = u.hostname === 'api.openai.com' ? { choices: [{ message: { content: 'mock openai reply' } }] } : { content: [{ type: 'text', text: 'mock claude reply' }] };
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  };
  const kv = new Map();
  const env = {
    CLAUDE_API_KEY: 'fake-claude', OPENAI_API_KEY: 'fake-openai',
    SCENES: { get: async (k, t) => { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); }, list: async () => ({ keys: [...kv.keys()].map(name => ({ name })), list_complete: true }), delete: async (k) => { kv.delete(k); } },
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) }
  };
  const worker = (await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href)).default;
  const base = 'https://gs.test';
  const origFetchForScenario = globalThis.fetch;
  // scenario() calls fetch(base + path): route those to the worker.
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname === 'gs.test') return worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
    return origFetchForScenario(req);
  };
  try { await scenario('[worker]', base, () => cap); } catch (e) { ok('[worker] scenario ran', false, e.stack); }
  globalThis.fetch = realFetch;
}

// Optional: the Worker in real workerd (wrangler dev) serves the new /api/prompts fields.
if (process.env.WORKER_BASE) {
  const pr = await (await fetch(process.env.WORKER_BASE + '/api/prompts')).json();
  ok(`[wrangler dev ${process.env.WORKER_BASE}] /api/prompts has the lighting section, required section and max`, /## Photorealistic lighting and materials/.test(pr.systemPrompt) && pr.chatPromptRequired === prompts.CHAT_PROMPT_REQUIRED && pr.maxCustomPromptChars === 40000);
  const r = await fetch(process.env.WORKER_BASE + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: msgs, systemPrompt: 'x'.repeat(40001) }) });
  ok(`[wrangler dev] over-long systemPrompt → 400 before any LLM call`, r.status === 400);
}

const fail = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
