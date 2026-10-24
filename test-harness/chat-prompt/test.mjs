// Chat → Prompt (editable Scene chat prompt) in the browser.
//   BASE=https://localhost:3995 node test.mjs
// /api/chat is mocked (request interception); nothing reaches an LLM and
// Community POSTs are blocked. Screenshots go to SHOT_DIR.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3995';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-prompt-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n}${e && !c ? ' — ' + e : ''}`); console.log(results.at(-1)); };
const KEY = 'gs.customChatPrompt.v1';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.createBrowserContext(); // one profile: localStorage survives reloads and pages
const defaults = await (await ctx.newPage()).evaluate(async (u) => (await fetch(u + '/api/prompts')).json(), BASE).catch(() => null);
const LIGHT_REPLY = 'Lit it.\n```vr-exec\n' + [
  "scene.getObjectByName('gsDefaultAmbient').intensity = 0.15;",
  "scene.getObjectByName('gsDefaultKey').intensity = 0;",
  'renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;',
  'renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1; renderer.outputColorSpace = THREE.SRGBColorSpace;',
  "const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');",
  'if (!scene.environment) { scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.4; }',
  'const key = new THREE.DirectionalLight(0xfff1e0, 2.5); key.name = "t_key"; key.position.set(3, 4, 1); key.castShadow = true;',
  'key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 15 }); key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;',
  'scene.add(key, key.target); key.target.position.set(0, 0, -2);',
  'const fill = new THREE.DirectionalLight(0xcfe0ff, 0.7); fill.position.set(-3, 2, 2); scene.add(fill);',
  'const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d"); g.fillStyle = "#8a6e52"; g.fillRect(0, 0, 64, 64); for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(30,30%,${30 + Math.random() * 20}%)`; g.fillRect(Math.random() * 64, Math.random() * 64, 2, 2); }',
  'const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(4, 4);',
  'const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.name = "t_floor"; scene.add(floor);',
  'const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 48, 24), new THREE.MeshPhysicalMaterial({ color: 0xb03030, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 })); ball.position.set(-0.4, 0.3, -2); ball.castShadow = true; scene.add(ball);',
  'const glass = new THREE.Mesh(new THREE.SphereGeometry(0.25, 48, 24), new THREE.MeshPhysicalMaterial({ roughness: 0.05, transmission: 1, ior: 1.5, thickness: 0.5 })); glass.position.set(0.4, 0.25, -2); glass.castShadow = true; scene.add(glass);',
  'window.__litOk = true;'
].join('\n') + '\n```';

async function open(vp, { phone = false } = {}) {
  const p = await ctx.newPage(); p._errs = []; p._chat = [];
  p.on('pageerror', e => p._errs.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ollama|11434/i.test(m.text())) p._errs.push(m.text().slice(0, 200)); });
  if (phone) await p.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
  await p.setViewport(vp);
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    if (u.includes('/api/community') && req.method() === 'POST') return req.respond({ status: 503, body: 'blocked' });
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(req.postData()); p._chat.push(body);
      const last = String(body.messages.at(-1)?.content || '');
      const text = /photoreal/i.test(last) ? LIGHT_REPLY : 'Mock reply ' + p._chat.length;
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text }] }) });
    }
    // Same model list on every host (wrangler dev has no keys, so it would list none).
    if (u.endsWith('/api/backends')) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { 'claude-sonnet-55': { label: 'Claude Sonnet 5.5', provider: 'claude', available: true }, 'openai-sol': { label: 'GPT6.1 Sol', provider: 'openai', available: true } }, default: 'claude-sonnet-55' }) });
    req.continue();
  });
  await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.GSChatPrompt?.getDefaults(), { timeout: 20000 });
  await sleep(800);
  return p;
}
const click = (p, sel) => p.evaluate(s => document.querySelector(s).click(), sel);
const st = (p) => p.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const ed = document.getElementById('dchat-prompt-editor');
  return {
    sectionOn: document.getElementById('dchat-chat-section-prompt').classList.contains('active'), editorVis: vis('dchat-prompt-editor'),
    value: ed.value, badge: document.getElementById('dchat-prompt-badge').textContent, dirty: !document.getElementById('dchat-prompt-dirty').hidden,
    count: document.getElementById('dchat-prompt-count').textContent, over: document.getElementById('dchat-prompt-count').classList.contains('over'),
    save: !document.getElementById('dchat-prompt-save').disabled, revert: !document.getElementById('dchat-prompt-revert').disabled, reset: !document.getElementById('dchat-prompt-reset').disabled,
    pill: !document.getElementById('dchat-custom-prompt-pill').hidden, dot: document.querySelector('[data-chat-section="prompt"]').classList.contains('has-custom'),
    stored: localStorage.getItem('gs.customChatPrompt.v1'), msg: document.getElementById('dchat-prompt-msg').textContent,
    required: document.getElementById('dchat-prompt-required').textContent, fix: document.getElementById('dchat-prompt-fix').textContent, theme: document.getElementById('dchat-prompt-theme').textContent,
    cls: document.documentElement.className
  };
});
async function sendChat(p, text) {
  const n = p._chat.length;
  await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="chat"]').click());
  await click(p, '[data-chat-section="scene"]');
  await p.evaluate((t) => { const i = document.getElementById('desktop-chat-input'); i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('desktop-send-button').click(); }, text);
  await p.waitForFunction((n) => true, {}, n);
  for (let i = 0; i < 50 && p._chat.length === n; i++) await sleep(100);
  await sleep(600);
  return p._chat[n];
}
const CUSTOM_LINE = '\n\n## House style\nAlways add a small brass plaque that reads "GS".';

// ------------------------------------------------------------------ desktop
{
  const H = '[desktop]';
  ok(`${H} /api/prompts has the default prompt, required section and max`, !!defaults && defaults.systemPrompt.length > 5000 && /GS technical requirements/.test(defaults.chatPromptRequired) && defaults.maxCustomPromptChars === 40000);
  ok(`${H} default prompt has the photorealistic lighting and materials section`, /## Photorealistic lighting and materials/.test(defaults.systemPrompt) && /PCFSoftShadowMap/.test(defaults.systemPrompt) && /ACESFilmicToneMapping/.test(defaults.systemPrompt) && /RoomEnvironment/.test(defaults.systemPrompt) && /PMREMGenerator/.test(defaults.systemPrompt) && /clearcoat/.test(defaults.systemPrompt) && /transmission/.test(defaults.systemPrompt) && /sheen/.test(defaults.systemPrompt) && /SRGBColorSpace/.test(defaults.systemPrompt) && /gsDefaultAmbient/.test(defaults.systemPrompt) && /no post-processing/.test(defaults.systemPrompt));
  const p = await open({ width: 1280, height: 860 });
  await p.evaluate(() => localStorage.removeItem('gs.customChatPrompt.v1'));
  await p.reload({ waitUntil: 'networkidle2' }); await p.waitForFunction(() => window.GSChatPrompt?.getDefaults()); await sleep(600);
  const tabs = await p.$$eval('#dchat-chat-subtabs .dchat-subtab', bs => bs.map(b => b.textContent.trim()));
  ok(`${H} Chat has Scene | Theme | Prompt subtabs (top tabs unchanged)`, tabs.join('|') === 'Scene|Theme|Prompt' && (await p.$$eval('.dchat-tab', t => t.length)) === 9, tabs.join('|'));
  let s = await st(p);
  ok(`${H} no custom prompt: no pill, no dot`, !s.pill && !s.dot && !/gs-custom-prompt/.test(s.cls));
  await click(p, '[data-chat-section="prompt"]'); await sleep(300);
  s = await st(p);
  ok(`${H} Prompt view shows the full default prompt`, s.sectionOn && s.editorVis && s.value === defaults.systemPrompt, `${s.value.length} vs ${defaults.systemPrompt.length}`);
  ok(`${H} badge "Default prompt", count n / 40,000, buttons idle`, s.badge === 'Default prompt' && s.count === `${defaults.systemPrompt.length.toLocaleString('en-US')} / 40,000` && !s.save && !s.revert && !s.reset, JSON.stringify([s.badge, s.count, s.save, s.revert, s.reset]));
  ok(`${H} required technical section and read-only fix / theme prompts shown`, s.required === defaults.chatPromptRequired && s.fix === defaults.fixCodePrompt && s.theme === defaults.themePrompt);
  ok(`${H} VR panel follows: section = prompt`, await p.evaluate(() => window.gsChatPanel.section) === 'prompt');
  await p.screenshot({ path: `${SHOT_DIR}/desktop-prompt-default.png` });
  // default: no systemPrompt in the request
  let req = await sendChat(p, 'hello');
  ok(`${H} default prompt: /api/chat body has no systemPrompt`, !!req && !('systemPrompt' in req), JSON.stringify(Object.keys(req || {})));
  // edit
  await click(p, '[data-chat-section="prompt"]');
  await p.focus('#dchat-prompt-editor');
  await p.evaluate(() => { const e = document.getElementById('dchat-prompt-editor'); e.setSelectionRange(e.value.length, e.value.length); });
  await p.keyboard.type(CUSTOM_LINE);
  s = await st(p);
  ok(`${H} typing marks unsaved changes; Save and Discard enabled; not saved yet`, s.dirty && s.save && s.revert && s.stored === null && s.badge === 'Default prompt');
  // discard
  await click(p, '#dchat-prompt-revert'); s = await st(p);
  ok(`${H} Discard changes restores the saved text`, s.value === defaults.systemPrompt && !s.dirty);
  await p.focus('#dchat-prompt-editor');
  await p.evaluate(() => { const e = document.getElementById('dchat-prompt-editor'); e.setSelectionRange(e.value.length, e.value.length); });
  await p.keyboard.type(CUSTOM_LINE);
  // Ctrl+S saves
  await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control'); await sleep(200);
  s = await st(p);
  const CUSTOM = defaults.systemPrompt + CUSTOM_LINE;
  ok(`${H} Ctrl+S saves to localStorage`, s.stored === CUSTOM && !s.dirty, s.msg);
  ok(`${H} custom indicators: badge, pill, subtab dot`, s.badge === 'Custom prompt active' && s.pill && s.dot && /gs-custom-prompt/.test(s.cls) && s.reset);
  await p.screenshot({ path: `${SHOT_DIR}/desktop-prompt-custom.png` });
  req = await sendChat(p, 'hello again');
  ok(`${H} custom prompt is sent with /api/chat`, req?.systemPrompt === CUSTOM && Array.isArray(req.messages) && 'backend' in req);
  await p.screenshot({ path: `${SHOT_DIR}/desktop-scene-custom-pill.png` });
  // pill opens the Prompt view
  await click(p, '#dchat-custom-prompt-pill'); await sleep(200);
  ok(`${H} "✎ Custom prompt" pill opens the Prompt view`, (await st(p)).sectionOn);
  // persists across reload
  await p.reload({ waitUntil: 'networkidle2' }); await p.waitForFunction(() => window.GSChatPrompt?.getDefaults()); await sleep(600);
  s = await st(p);
  ok(`${H} custom prompt persists across reload`, s.value === CUSTOM && s.badge === 'Custom prompt active' && s.pill);
  req = await sendChat(p, 'after reload');
  ok(`${H} after reload the custom prompt is still sent`, req?.systemPrompt === CUSTOM);
  // too long
  await click(p, '[data-chat-section="prompt"]');
  await p.evaluate(() => { const e = document.getElementById('dchat-prompt-editor'); e.value = 'x'.repeat(40001); e.dispatchEvent(new Event('input')); });
  s = await st(p);
  ok(`${H} over 40,000 chars: count turns red and Save is disabled`, s.over && !s.save && s.count === '40,001 / 40,000');
  await click(p, '#dchat-prompt-revert');
  // saving text identical to the default = default
  await p.evaluate((d) => { const e = document.getElementById('dchat-prompt-editor'); e.value = d; e.dispatchEvent(new Event('input')); document.getElementById('dchat-prompt-save').click(); }, defaults.systemPrompt);
  s = await st(p);
  ok(`${H} saving the default text clears the custom prompt`, s.stored === null && s.badge === 'Default prompt' && !s.pill);
  await p.evaluate((c) => { const e = document.getElementById('dchat-prompt-editor'); e.value = c; e.dispatchEvent(new Event('input')); document.getElementById('dchat-prompt-save').click(); }, CUSTOM);
  // reset: cancel keeps it, accept resets
  let dialogs = 0;
  const onDlg = (accept) => async (d) => { dialogs++; accept ? await d.accept() : await d.dismiss(); };
  let h = onDlg(false); p.once('dialog', h);
  await click(p, '#dchat-prompt-reset'); await sleep(300);
  s = await st(p);
  ok(`${H} Reset to default asks first; Cancel keeps the custom prompt`, dialogs === 1 && s.stored === CUSTOM);
  h = onDlg(true); p.once('dialog', h);
  await click(p, '#dchat-prompt-reset'); await sleep(300);
  s = await st(p);
  ok(`${H} Reset to default (OK) restores the default`, dialogs === 2 && s.stored === null && s.value === defaults.systemPrompt && s.badge === 'Default prompt' && !s.pill && !s.dot);
  req = await sendChat(p, 'after reset');
  ok(`${H} after reset no systemPrompt is sent`, !!req && !('systemPrompt' in req));
  // another tab sees saves (storage event)
  const p2 = await open({ width: 1000, height: 800 });
  await p.evaluate((c) => window.GSChatPrompt.saveCustom(c), CUSTOM); await sleep(400);
  const s2 = await st(p2);
  ok(`${H} a second tab picks up the saved prompt`, s2.value === CUSTOM && s2.badge === 'Custom prompt active');
  await p2.close();
  // headset panel
  await click(p, '[data-chat-section="prompt"]'); await sleep(200);
  const vr = await p.evaluate(() => { const c = window.gsChatPanel.canvas; return { url: c.toDataURL('image/png'), w: c.width, h: c.height }; });
  fs.writeFileSync(`${SHOT_DIR}/vr-panel-prompt-custom.png`, Buffer.from(vr.url.split(',')[1], 'base64'));
  ok(`${H} headset panel draws the Prompt section`, vr.url.length > 20000, String(vr.url.length));
  await p.evaluate(() => window.gsChatPanel.xrSend('Prefer warm evening light.')); await sleep(200);
  s = await st(p);
  ok(`${H} headset Send in Prompt appends a line to the prompt`, s.stored === CUSTOM + '\n\nPrefer warm evening light.' && s.value === s.stored);
  await p.evaluate(() => window.gsChatPanel.action('prompt:reset'));
  ok(`${H} headset Reset needs a second press`, (await st(p)).stored !== null);
  await p.evaluate(() => window.gsChatPanel.action('prompt:reset')); await sleep(100);
  s = await st(p);
  ok(`${H} headset Reset (second press) restores the default`, s.stored === null && s.badge === 'Default prompt');
  const vr2 = await p.evaluate(() => window.gsChatPanel.canvas.toDataURL('image/png'));
  fs.writeFileSync(`${SHOT_DIR}/vr-panel-prompt-default.png`, Buffer.from(vr2.split(',')[1], 'base64'));
  await p.evaluate(() => window.gsChatPanel.action('chatSection:scene'));
  ok(`${H} headset subtab back to Scene`, await p.evaluate(() => window.gsChatPanel.section === 'scene' && document.getElementById('dchat-chat-section-scene').classList.contains('active')));
  // the lighting recipe in the prompt runs as written
  req = await sendChat(p, 'make it photoreal');
  await p.waitForFunction(() => window.__litOk === true, { timeout: 15000 }).catch(() => {});
  const lit = await p.evaluate(() => ({ ok: window.__litOk, env: !!scene.environment, tm: renderer.toneMapping === THREE.ACESFilmicToneMapping, sh: renderer.shadowMap.enabled && renderer.shadowMap.type === THREE.PCFSoftShadowMap, amb: scene.getObjectByName('gsDefaultAmbient')?.intensity, key: scene.getObjectByName('gsDefaultKey')?.intensity }));
  ok(`${H} the prompt's lighting recipe runs in a vr-exec block (RoomEnvironment import, shadows, ACES, named defaults)`, lit.ok && lit.env && lit.tm && lit.sh && lit.amb === 0.15 && lit.key === 0, JSON.stringify(lit));
  await p.evaluate(() => { const c = document.getElementById('desktop-chat'); c.style.visibility = 'hidden'; });
  const cam = await p.evaluate(() => [camera.position.toArray().map(v => +v.toFixed(2)), camera.getWorldDirection(new THREE.Vector3()).toArray().map(v => +v.toFixed(2))]); console.log('camera', JSON.stringify(cam));
  await sleep(800);
  await p.screenshot({ path: `${SHOT_DIR}/desktop-photoreal-recipe.png` });
  await p.evaluate(() => { document.getElementById('desktop-chat').style.visibility = ''; });
  ok(`${H} no console errors`, p._errs.length === 0, p._errs.join(' | '));
  await p.close();
}

// ------------------------------------------------------------------ phone
for (const vp of [{ name: '390x844', width: 390, height: 844 }, { name: '844x390', width: 844, height: 390 }]) {
  const H = `[phone ${vp.name}]`;
  const view = { width: vp.width, height: vp.height, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const p = await open(view, { phone: true });
  await p.evaluate(() => localStorage.removeItem('gs.customChatPrompt.v1'));
  await p.reload({ waitUntil: 'networkidle2' }); await p.waitForFunction(() => window.GSChatPrompt?.getDefaults()); await sleep(800);
  ok(`${H} phone layout`, /gs-phone/.test((await st(p)).cls));
  const tapSel = async (sel) => { const r = await p.evaluate(s => { const e = document.querySelector(s); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel); await p.touchscreen.tap(r[0], r[1]); await sleep(300); };
  await tapSel('[data-chat-section="prompt"]');
  let s = await st(p);
  ok(`${H} Prompt view opens with the default prompt`, s.sectionOn && s.editorVis && s.value === defaults.systemPrompt);
  const m = await p.evaluate(() => {
    const ed = document.getElementById('dchat-prompt-editor'); const r = ed.getBoundingClientRect();
    const btns = [...document.querySelectorAll('#dchat-prompt-actions button, #dchat-chat-subtabs button')].map(b => { const q = b.getBoundingClientRect(); return [b.textContent.trim(), Math.round(q.width), Math.round(q.height)]; });
    return { font: parseFloat(getComputedStyle(ed).fontSize), w: r.width, right: r.right, iw: innerWidth, h: r.height, btns };
  });
  ok(`${H} editor is 16px (no iOS zoom) and fits the width`, m.font >= 16 && m.right <= m.iw + 0.5 && m.h >= 100, JSON.stringify(m));
  ok(`${H} subtabs and Save / Discard / Reset are >= 44px tall`, m.btns.every(([, w, hh]) => hh >= 44 && w >= 44), JSON.stringify(m.btns));
  await p.screenshot({ path: `${SHOT_DIR}/phone-${vp.name}-prompt-default.png` });
  // keyboard (Android style: the window shrinks)
  await tapSel('#dchat-prompt-editor');
  const kb = Math.round(vp.height > vp.width ? vp.height * 0.4 : vp.height * 0.52);
  for (const f of [0.3, 0.7, 1]) { await p.setViewport({ ...view, height: vp.height - Math.round(kb * f) }); await sleep(60); }
  await sleep(600);
  await p.evaluate(() => { const e = document.getElementById('dchat-prompt-editor'); e.setSelectionRange(e.value.length, e.value.length); });
  await p.keyboard.type(' Keep it cosy.');
  s = await st(p);
  const k = await p.evaluate(() => {
    const R = (sel) => { const e = document.querySelector(sel); const r = e?.getBoundingClientRect(); return r && r.height > 0 && getComputedStyle(e).display !== 'none' ? { t: r.top, b: r.bottom } : null; };
    return { vh: visualViewport.height, ed: R('#dchat-prompt-editor'), save: R('#dchat-prompt-save'), tabs: R('#desktop-chat-tabs'), sub: R('#dchat-chat-subtabs'), note: R('#dchat-prompt-note'), active: document.activeElement?.id };
  });
  ok(`${H} keyboard up: compact layout (gs-kb-chat), tabs and notes hidden`, /gs-kb-chat/.test(s.cls) && !k.tabs && !k.sub && !k.note, JSON.stringify(k));
  ok(`${H} keyboard up: editor and Save are inside the visible area`, k.ed && k.save && k.ed.t >= -0.5 && k.save.b <= k.vh + 0.5 && k.ed.b - k.ed.t > 60, JSON.stringify(k));
  ok(`${H} typing with the keyboard up marks unsaved changes`, s.dirty && s.value.endsWith(' Keep it cosy.') && k.active === 'dchat-prompt-editor');
  await p.screenshot({ path: `${SHOT_DIR}/phone-${vp.name}-prompt-keyboard.png` });
  await tapSel('#dchat-prompt-save');
  s = await st(p);
  ok(`${H} Save with the keyboard up saves and keeps focus`, s.stored === defaults.systemPrompt + ' Keep it cosy.' && !s.dirty && (await p.evaluate(() => document.activeElement?.id)) === 'dchat-prompt-editor');
  await p.evaluate(() => document.activeElement.blur());
  await p.setViewport(view); await sleep(700);
  s = await st(p);
  ok(`${H} keyboard closed: full layout back, custom badge shown`, !/gs-kb/.test(s.cls) && s.badge === 'Custom prompt active');
  await p.screenshot({ path: `${SHOT_DIR}/phone-${vp.name}-prompt-custom.png` });
  await tapSel('[data-chat-section="scene"]');
  const pill = await p.evaluate(() => { const r = document.getElementById('dchat-custom-prompt-pill').getBoundingClientRect(); return { h: r.height, right: r.right, iw: innerWidth }; });
  ok(`${H} Scene view shows the custom-prompt pill (44px, fits)`, pill.h >= 44 && pill.right <= pill.iw + 0.5, JSON.stringify(pill));
  if (vp.width < vp.height) await p.screenshot({ path: `${SHOT_DIR}/phone-${vp.name}-scene-custom-pill.png` });
  const req = await sendChat(p, 'hi from phone');
  ok(`${H} phone send carries the custom prompt`, req?.systemPrompt === defaults.systemPrompt + ' Keep it cosy.');
  await tapSel('#dchat-custom-prompt-pill');
  p.once('dialog', d => d.accept());
  await tapSel('#dchat-prompt-reset');
  s = await st(p);
  ok(`${H} Reset to default on phone`, s.stored === null && s.badge === 'Default prompt');
  ok(`${H} no console errors`, p._errs.length === 0, p._errs.join(' | '));
  await p.close();
}

await b.close();
const fail = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fail}/${results.length} passed`);
fs.writeFileSync('results.txt', results.join('\n') + `\n${results.length - fail}/${results.length} passed\n`);
process.exit(fail ? 1 : 0);
