// VR screenshots in an IWER-emulated Meta Quest 3 (stereo frame as the page canvas shows it).
// BASE=https://localhost:3711 OUT=/workspace/gs-vrui-shots PREFIX=after node shots.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3711';
const OUT = process.env.OUT || '/workspace/gs-vrui-shots';
const PREFIX = process.env.PREFIX || 'after';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.setViewport({ width: 1600, height: 900 });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p.setRequestInterception(true);
p.on('request', req => { const u = new URL(req.url());
  if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
  if (u.pathname === '/api/community-scenes') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenes: [{ id: 'a1', name: 'Dancing Ducks!', createdAt: '2026-10-20T10:00:00Z' }, { id: 'b2', name: 'Martian Library', createdAt: '2026-10-21T10:00:00Z' }] }) });
  req.continue(); });
await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(2500);
await p.evaluate(() => { const g = new THREE.GridHelper(20, 40, 0x888888, 0x444444); scene.add(g);
  for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: [0xff5533, 0x33aaff, 0x66dd55, 0xffcc33, 0xcc66ff, 0xffffff][i] })); m.position.set(-2.5 + i, 0.2, -3.5); scene.add(m); } });
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
await sleep(2000);
const shoot = async (name, yawDeg = 0, pitchDeg = -8) => {
  await p.evaluate((y, pt) => { const d = window.__xrDevice; const e = new THREE.Euler(THREE.MathUtils.degToRad(pt), THREE.MathUtils.degToRad(y), 0, 'YXZ'); const q = new THREE.Quaternion().setFromEuler(e); d.quaternion.set(q.x, q.y, q.z, q.w); d.position.set(0, 1.6, 0.35); }, yawDeg, pitchDeg);
  await sleep(1500);
  await p.screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
};
await shoot('vr-front', 0);
await shoot('vr-left', 28);
await shoot('vr-right', -28);
// Code tab via the DOM (both builds keep #desktop-chat in sync)
await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="code"]')?.click()); await sleep(800);
await p.evaluate(() => { try { handleMenuAction && handleMenuAction('panel:code'); } catch {} });
await shoot('vr-code', 0);
await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="community"]')?.click()); await sleep(800);
await shoot('vr-community', 0);
await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="controls"]')?.click()); await sleep(800);
await shoot('vr-controls', 0);
// Typing: open the in-scene keyboard on the chat input (new build only).
const typed = await p.evaluate(() => { const W = window.__gsVrWindows; if (!W) return false; document.querySelector('.dchat-tab[data-tab="chat"]')?.click();
  const w = W.byName('menu'), el = document.getElementById('desktop-chat-input'); const sr = w.source.getBoundingClientRect(), r = el.getBoundingClientRect();
  w.click({ x: (r.left + r.width / 2 - sr.left) / sr.width, y: 1 - (r.top + r.height / 2 - sr.top) / sr.height }); return true; });
if (typed) { await sleep(800); await shoot('vr-keyboard', 0, -18); }
// Full-resolution texture of each VR window (what the headset samples).
const tex = await p.evaluate(() => (window.__gsVrWindows ? window.__gsVrWindows.windows.filter((w) => w.paints > 0).map((w) => [w.name, w.canvas.toDataURL('image/png')]) : []));
for (const [n, url] of tex) fs.writeFileSync(`${OUT}/${PREFIX}-texture-${n}.png`, Buffer.from(url.split(',')[1], 'base64'));
console.log('shots done', PREFIX, errs.length ? errs.slice(0, 3) : 'no errors');
await b.close();
