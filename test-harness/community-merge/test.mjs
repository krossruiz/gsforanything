import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3701';
const HOT = process.env.HOT === '1'; // after rebase onto 0.973: gs.state + gsImportP5Sketch exist
// CUSTOM_PROMPT=1: a custom Scene chat prompt (Chat → Prompt) is saved first; the merge request must carry it.
const CUSTOM_PROMPT = process.env.CUSTOM_PROMPT === '1' ? 'Custom merge-test prompt.\nKeep everything tidy.' : null;
const B64 = fs.readFileSync('noise.b64', 'utf8').trim();
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); console.log(results.at(-1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = async (body) => (await fetch(BASE + '/api/community-scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (id) => { const r = await (await fetch(`${BASE}/api/community-scenes/${id}`)).json(); for (const k of ['url', 'pathname', 'uploadedAt', 'editorUrl', 'viewUrl']) delete r[k]; return r; };

const stateExpr = HOT ? 'gs.state' : '(window.runnerState ??= {})';
const A_CODE = [
  `// Runner: player + controls\nconst st = ${stateExpr}; st.score ??= 0;\nconst player = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.3,0.3), new THREE.MeshStandardMaterial({ color: 0x33aaff }));\nplayer.name = 'a_player'; player.position.set(0, 0.15, -1.5); scene.add(player);\nwindow._vrAnimations.push(() => { if (gsGamepad.connected) player.position.x += gsGamepad.axis('leftX') * 0.02; });`,
  `// Runner: score HUD\nwindow.runnerHud = 'score';`
];
const P5_BLOCK = HOT
  ? `await gsImportP5Sketch({\n\tname: "Cat Garden sketch",\n\tfiles: {\n\t\t"sketch.js": \`let img; function preload(){ img = loadImage('assets/cat.png'); } function setup(){ createCanvas(120, 90); } function draw(){ background(20); image(img, 10, 10); }\`,\n\t\t"assets/cat.png": {"base64":"${B64}","type":"image/png"}\n\t}\n});`
  : `window.catFiles = {\n\t"sketch.js": "function draw(){}",\n\t"assets/cat.png": {"base64":"${B64}","type":"image/png"}\n};`;
const B_CODE = [
  P5_BLOCK,
  `// Cat Garden: textured box + warm light\nconst tex = new THREE.TextureLoader().load("data:image/png;base64,${B64}");\nconst box = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.5), new THREE.MeshBasicMaterial({ map: tex })); box.name = 'b_catBox'; box.position.set(0.8, 0.25, -2); scene.add(box);\nconst warm = new THREE.PointLight(0xffaa66, 2, 6); warm.name = 'b_warm'; warm.position.set(0, 2, -1); scene.add(warm);`
];

function mergeReply() {
  const keepB1 = HOT ? '\n```vr-exec\n// @gs-keep B1\n```' : '';
  return `Merged scene below.
\`\`\`vr-exec
// @gs-keep A1
\`\`\`${keepB1}
\`\`\`vr-exec
// Assets from B, carried by token
window.catFiles = { "assets/cat.png": { "base64": __GS_ASSET_B1__, "type": "image/png" } };
const tex = new THREE.TextureLoader().load(__GS_ASSET_B2__);
const box = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.5), new THREE.MeshBasicMaterial({ map: tex }));
box.name = 'b_catBox'; box.position.set(0.8, 0.25, -2); scene.add(box);
window.mergeOk = true;
\`\`\`
\`\`\`vr-exec
const again = __GS_ASSET_B2__;
notARealFunction(again);
\`\`\`
From A: the player and its gamepad controls. From B: the cat texture and image asset.`;
}

async function newPage(vp) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  p._errs = []; p._chat = []; p._fix = [];
  p.on('pageerror', e => p._errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ollama|11434|merged block error|vr-exec error/i.test(m.text())) p._errs.push(m.text()); });
  if (CUSTOM_PROMPT) await p.evaluateOnNewDocument((t) => { if (window === window.top) try { localStorage.setItem('gs.customChatPrompt.v1', t); } catch { /* sandboxed frame */ } }, CUSTOM_PROMPT);
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(req.postData()); p._chat.push(body);
      const last = body.messages.at(-1).content;
      const text = /\[GS scene merge request\]/.test(last) ? mergeReply() : `Sure.\n\`\`\`vr-exec\nwindow.chatTurn = (window.chatTurn || 0) + 1;\n\`\`\``;
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text }] }) });
    }
    if (u.endsWith('/api/fix-code')) {
      const body = JSON.parse(req.postData()); p._fix.push(body);
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: '```vr-exec\nconst again = __GS_ASSET_B2__;\nwindow.fixedLen = again.length;\n```' }] }) });
    }
    if (u.endsWith('/api/backends')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { 'claude-haiku-55': { label: 'Claude Haiku 5.5', provider: 'claude', available: true }, 'claude-sonnet-55': { label: 'Claude Sonnet 5.5', provider: 'claude', available: true } }, default: 'claude-sonnet-55' }) });
    req.continue();
  });
  if (vp.isMobile) await p.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
  await p.setViewport(vp);
  await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  return p;
}
const tab = async (p, t) => { await p.evaluate((t) => document.querySelector(`.dchat-tab[data-tab="${t}"]`).click(), t); await sleep(400); };
const chatText = (p) => p.evaluate(() => [...document.querySelectorAll('#desktop-chat-messages .dchat-msg')].map(e => e.textContent));
const sceneHas = (p, name) => p.evaluate((n) => { let f = null; window.__gsScene?.traverse?.(o => { if (o.name === n) f = o; }); return !!f; }, name);

// Seed: A published WITH a creation context (via the author flow is covered by PR #4 tests; here a minimal real envelope)
const seed = await newPage({ width: 1280, height: 900 });
const envA = await seed.evaluate(async () => {
  GSContext.recordUserTurn({ text: 'make a runner game with gamepad controls', backend: 'claude-sonnet-55', model: 'Claude Sonnet 5.5' });
  GSContext.recordAssistantTurn({ raw: 'ok', display: 'ok' });
  return (await GSContext.packContext({ sceneName: 'Runner' })).envelope;
});
await seed.browserContext().close();
const A = await post({ version: 1, name: 'Runner', codeBlocks: A_CODE, creationContext: envA });
const B = await post({ version: 1, name: 'Cat Garden', codeBlocks: B_CODE });
const beforeA = JSON.stringify(await get(A.id)), beforeB = JSON.stringify(await get(B.id));

for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]) {
  const H = `[${vp.name}]`;
  const p = await newPage(vp);
  await p.evaluate(() => { window.__gsScene = null; }); // set below
  await p.evaluate(() => { const THREEscene = (window.__findScene = () => null); });
  await tab(p, 'community'); await sleep(1500);
  ok(`${H} Merge scenes button in Community`, await p.$('#gs-merge-open') !== null);
  const rowBtns = await p.$$eval('.gs-merge-row-btn', bs => bs.length);
  ok(`${H} Merge button on each row`, rowBtns >= 2, String(rowBtns));
  // Pick A then B from the rows -> dialog opens prefilled
  await p.evaluate((a, bb) => { for (const id of [a, bb]) document.querySelector(`.gs-merge-row-btn[data-scene-id="${id}"]`).click(); }, A.id, B.id);
  await sleep(600);
  const dlg = await p.evaluate(() => { const m = document.getElementById('gs-merge-modal'); const r = document.getElementById('gs-merge-inner').getBoundingClientRect(); return { vis: m.classList.contains('visible'), a: document.getElementById('gs-merge-A').value, b: document.getElementById('gs-merge-B').value, w: r.width, vw: innerWidth, models: [...document.querySelectorAll('#gs-merge-model option')].map(o => o.textContent), bar: document.getElementById('gs-merge-sel').textContent }; });
  ok(`${H} picking two rows opens the dialog prefilled`, dlg.vis && dlg.a === A.id && dlg.b === B.id, JSON.stringify(dlg).slice(0, 300));
  ok(`${H} dialog fits the viewport`, dlg.w <= dlg.vw, `${dlg.w} <= ${dlg.vw}`);
  // Search filter
  await p.type('#gs-merge-search-B', 'cat'); await sleep(200);
  const filtered = await p.$$eval('#gs-merge-B option', os => os.map(o => o.textContent));
  ok(`${H} picker search filters`, filtered.slice(1).every(t => /cat/i.test(t)) && filtered.some(t => /^Cat Garden/.test(t)) && !filtered.some(t => /^Runner ·/.test(t)), filtered.join(' | '));
  // Model, picks, prompt
  await p.select('#gs-merge-model', 'claude-haiku-55');
  const mainModel = await p.$eval('#desktop-model-select', s => s.value);
  ok(`${H} model picker drives the chat model dropdown`, mainModel === 'claude-haiku-55');
  await p.click('[data-aspect="gameplay"][data-from="A"]'); await p.click('[data-aspect="controls"][data-from="A"]'); await p.click('[data-aspect="assets"][data-from="B"]'); await p.click('[data-aspect="environment"][data-from="B"]');
  await p.click('[data-aspect="assets"][data-from="both"]'); await p.click('[data-aspect="assets"][data-from="B"]'); // exclusive per row
  await p.type('#gs-merge-prompt', 'Gameplay and controls from A, assets and art style from B.');
  await p.click('#gs-merge-go');
  await p.waitForFunction(() => !document.getElementById('gs-merge-modal').classList.contains('visible') || document.getElementById('gs-merge-status').classList.contains('error'), { timeout: 30000 });
  await sleep(1500);
  const status = await p.$eval('#gs-merge-status', e => e.textContent);
  const mreq = p._chat.find(c => /\[GS scene merge request\]/.test(c.messages.at(-1).content));
  const msg = mreq?.messages.at(-1).content || '';
  ok(`${H} merge request went through the chat backend with the chosen model`, !!mreq && mreq.backend === 'claude-haiku-55', status);
  ok(`${H} merge request carries the Scene chat prompt setting (${CUSTOM_PROMPT ? 'custom' : 'default = none sent'})`, !!mreq && (CUSTOM_PROMPT ? mreq.systemPrompt === CUSTOM_PROMPT : !('systemPrompt' in mreq)));
  ok(`${H} request has no base64 (assets tokenised)`, !msg.includes(B64.slice(0, 64)) && !msg.includes(B64.slice(-64)) && /__GS_ASSET_B1__: base64 data \(image\/png\)/.test(msg) && /__GS_ASSET_B2__: data: URL \(image\/png\)/.test(msg), `${msg.length} chars`);
  ok(`${H} request has both scenes' code, settings, history, picks, prompt`, /Scene A: "Runner"/.test(msg) && /Scene B: "Cat Garden"/.test(msg) && /a_player/.test(msg) && /b_warm/.test(msg) && /make a runner game with gamepad controls/.test(msg) && /Environment: 3D \/ three/.test(msg) && /Creation history: none saved/.test(msg) && /Gameplay logic: from A/.test(msg) && /Assets \/ models: from B/.test(msg) && !/Assets \/ models: combine/.test(msg) && /assets and art style from B/.test(msg) && /GS editor settings/.test(msg));
  ok(`${H} request explains GS conventions`, /gs\.state/.test(msg) && /gsGamepad/.test(msg) && /gsRequire\('ammo'\)/.test(msg) && /gsImportP5Sketch/.test(msg) && /@gs-keep/.test(msg));
  const fix = p._fix[0];
  ok(`${H} failing block auto-fixed without base64 in the fix call`, !!fix && /__GS_ASSET_B2__/.test(fix.failingCode) && !fix.failingCode.includes(B64.slice(0, 64)));
  const run = await p.evaluate((b64) => ({ ok: window.mergeOk, cat: window.catFiles?.['assets/cat.png']?.base64 === b64, fixedLen: window.fixedLen, hud: window.runnerHud }), B64);
  ok(`${H} merged scene ran: kept A block, assets re-substituted byte-exact, fix ran`, run.ok === true && run.cat && run.fixedLen === ('data:image/png;base64,' + B64).length, JSON.stringify(run));
  ok(`${H} only the requested A block was kept`, run.hud === undefined);
  await p.click('.dchat-tab[data-tab="code"]'); await sleep(500); await p.click('#dchat-code-apply'); await sleep(1500);
  const hot = await p.evaluate(() => document.getElementById('dchat-code-status')?.textContent || '');
  ok(`${H} merged blocks run under scene block keys (Apply = no code changes)`, /no code changes/.test(hot), hot);
  await p.click('.dchat-tab[data-tab="chat"]'); await sleep(400);
  const objs = await p.evaluate(() => { const names = []; const root = document.querySelector('canvas'); return names; });
  const chat = await chatText(p);
  ok(`${H} chat shows the merge turn and summary`, chat.some(t => /🔀 Merge "Runner" \(A\) \+ "Cat Garden" \(B\)/.test(t)) && chat.some(t => /\[Merged scene "Runner \+ Cat Garden \(merged\)" loaded: \d+ blocks, \d+ reused as-is \(A1.*\), \d+ embedded assets? carried over, 1 auto-fixed\. Originals unchanged\.\]/.test(t)), chat.slice(-1)[0]?.slice(-200));
  // Keep chatting -> merge is in the history
  await tab(p, 'chat');
  await p.type('#desktop-chat-input', 'make the cat box bigger');
  await p.click('#desktop-send-button'); await sleep(2000);
  const next = p._chat.at(-1).messages;
  ok(`${H} continuing the chat includes the merge`, next.some(m => m.role === 'user' && /I merged two Community scenes/.test(m.content) && new RegExp(A.id).test(m.content)) && next.some(m => m.role === 'assistant' && /@gs-keep A1/.test(m.content)) && !JSON.stringify(next).includes(B64.slice(0, 64)));
  // Publish the merged scene -> credits + parents in the context, originals untouched
  await tab(p, 'community');
  await p.evaluate(() => document.querySelector('#dchat-community-buttons [data-action="community:upload"]').click());
  await p.waitForSelector('#gs-ctx-publish.visible'); await sleep(600);
  const upP = p.waitForResponse(r => r.url().endsWith('/api/community-scenes') && r.request().method() === 'POST');
  await p.click('#gs-ctx-publish-btn');
  const up = await upP; const upBody = JSON.parse(up.request().postData()); const mergedId = (await up.json()).id;
  ok(`${H} published merged scene credits both parents`, upBody.name === 'Runner + Cat Garden (merged)' && upBody.mergedFrom?.length === 2 && upBody.mergedFrom[0].id === A.id && upBody.mergedFrom[1].id === B.id && /Merged from "Runner" \+ "Cat Garden"/.test(upBody.credits), JSON.stringify(upBody.mergedFrom));
  ok(`${H} published code has real assets, no tokens or keep markers`, !/__GS_ASSET_|@gs-keep/.test(JSON.stringify(upBody.codeBlocks)) && JSON.stringify(upBody.codeBlocks).includes(B64.slice(0, 64)), `${upBody.codeBlocks.length} blocks`);
  const dec = await p.evaluate(async (env) => { const bytes = Uint8Array.from(atob(env.data), c => c.charCodeAt(0)); return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()); }, upBody.creationContext);
  ok(`${H} creation context records parents, prompt, picks`, dec.merges?.[0]?.parents?.map(x => x.id).join() === `${A.id},${B.id}` && /assets and art style from B/.test(dec.merges[0].prompt) && dec.merges[0].picks.gameplay === 'A' && dec.chat.some(e => /🔀 Merge/.test(e.text || '')));
  ok(`${H} originals untouched`, JSON.stringify(await get(A.id)) === beforeA && JSON.stringify(await get(B.id)) === beforeB);
  await p.evaluate(() => document.getElementById('share-close-btn')?.click());
  ok(`${H} no console errors`, p._errs.length === 0, p._errs.slice(0, 3).join(' | '));
  await p.screenshot({ path: `merged-${vp.name}.png` });
  await p.browserContext().close();

  // Reopen the merged scene in a fresh page
  const v = await newPage(vp);
  await tab(v, 'community'); await sleep(1500);
  await v.evaluate((id) => { const row = [...document.querySelectorAll('#dchat-community-list .dchat-community-scene')].find(r => r.querySelector('.dchat-scene-name').title.includes(id)); row.querySelector('.dchat-btn').click(); }, mergedId);
  await sleep(3000);
  const vchat = await chatText(v);
  const vrun = await v.evaluate((b64) => ({ ok: window.mergeOk, cat: window.catFiles?.['assets/cat.png']?.base64 === b64, fixedLen: window.fixedLen }), B64);
  ok(`${H} reopened merged scene runs and shows its parents`, vrun.ok && vrun.cat && vrun.fixedLen > 7000 && vchat.some(t => /Merged from "Runner" \+ "Cat Garden" with the prompt/.test(t)), JSON.stringify(vrun));
  ok(`${H} no console errors (reopen)`, v._errs.length === 0, v._errs.slice(0, 3).join(' | '));
  await v.browserContext().close();
}

// Dialog screenshot on phone + error path (unknown token)
const e = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await tab(e, 'community'); await sleep(1200);
await e.click('#gs-merge-open'); await sleep(500);
await e.screenshot({ path: 'dialog-phone.png' });
const errRun = await e.evaluate(async (a, bb) => { try { const t = { assets: new Map(), blocks: new Map() }; GSMerge.expandMergedBlocks(['x = __GS_ASSET_A7__'], t); return 'no error'; } catch (err) { return err.message; } }, A.id, B.id);
ok('[phone] unknown asset token is rejected', /unknown asset token __GS_ASSET_A7__/.test(errRun));
const same = await e.evaluate((id) => { document.getElementById('gs-merge-A').value = id; document.getElementById('gs-merge-B').value = id; document.getElementById('gs-merge-go').click(); return new Promise(r => setTimeout(() => r(document.getElementById('gs-merge-status').textContent), 300)); }, A.id);
ok('[phone] same scene twice is refused', /two different scenes/.test(same), same);
ok('[phone] no console errors (dialog)', e._errs.length === 0, e._errs.join(' | '));
await b.close();
const fails = results.filter(r => r.startsWith('FAIL'));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
fs.writeFileSync('results.txt', results.join('\n') + `\n${results.length - fails.length}/${results.length} passed\n`);
