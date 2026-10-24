// VR windows suite: every VR window is an html-in-canvas window driven by
// vrWindows.js, rays point/click/drag/scroll/type on each one, the key colour
// pairs meet WCAG AA, the removed "Lay down" option is gone (and a stored
// lay-down state loads as normal), Fixed/Follow still works, no console errors.
//   npm i && BASE=https://localhost:3711 node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3711';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const AUDIT = fs.readFileSync(new URL('./contrast-audit.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };

const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await p.setViewport({ width: 1600, height: 900 });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
// A lay-down state an older build/test might have stored: must load as normal.
await p.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); localStorage.setItem('gs.layDown', 'true'); localStorage.setItem('gsLayDownView', '1'); } });
await p.setRequestInterception(true);
p.on('request', (req) => { const u = new URL(req.url());
	if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
	if (u.pathname === '/api/community-scenes') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ scenes: [] }) });
	req.continue(); });
await p.goto(BASE + '/', { waitUntil: 'networkidle2' });
await sleep(2000);

// ---- lay-down removed + migrated ----
const lay = await p.evaluate(() => {
	const keys = []; for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
	const txt = document.body.innerText + ' ' + [...document.querySelectorAll('[data-action],[aria-label],[title]')].map((e) => [e.dataset.action, e.getAttribute('aria-label'), e.getAttribute('title'), e.textContent].join(' ')).join(' ');
	return { stale: keys.filter((k) => /lay[\s_.-]?down/i.test(k)), menuHasLayDown: /lay[\s_-]?down|sit up/i.test(txt) };
});
check('Saved lay-down state migrated (keys removed)', lay.stale.length === 0, lay.stale);
check('No "Lay down" / "Sit up" option anywhere in the menu', !lay.menuHasLayDown);
const src = fs.readFileSync(new URL('../../site-source/main.js', import.meta.url), 'utf8');
check('No lay-down action/code left in main.js', !/env:layDown|toggleLayDownView|applyLayDownView|layDownView/.test(src));

// ---- enter VR ----
await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0); d.quaternion.set(0, 0, 0, 1); });
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
check('Entered immersive VR (IWER Quest 3)', await p.evaluate(() => renderer.xr.isPresenting));
await sleep(1500);

await p.evaluate(() => {
	const V = THREE.Vector3;
	window.__t = {
		win: (n) => window.__gsVrWindows.byName(n),
		pointFor(el, winName) {
			const w = this.win(winName); const sr = w.source.getBoundingClientRect(); const r = el.getBoundingClientRect();
			const u = (r.left + r.width / 2 - sr.left) / sr.width, v = 1 - (r.top + r.height / 2 - sr.top) / sr.height;
			w.mesh.updateMatrixWorld(true);
			return w.mesh.localToWorld(new V(u - 0.5, v - 0.5, 0.0));
		},
		// Point a controller's target ray (world space) at a world point.
		aim(hand, target) {
			const c = [0, 1].map((i) => renderer.xr.getController(i)).find((x) => x.userData.handedness === hand);
			const xrCam = renderer.xr.getCamera(); const head = new V(); xrCam.getWorldPosition(head);
			const origin = head.clone().add(new V(hand === 'right' ? 0.15 : -0.15, -0.3, -0.1));
			const parent = c.parent; parent.updateMatrixWorld(true);
			const inv = parent.matrixWorld.clone().invert();
			const o = origin.clone().applyMatrix4(inv), t = target.clone().applyMatrix4(inv);
			const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(o, t, new V(0, 1, 0)));
			const dc = window.__xrDevice.controllers[hand];
			dc.position.set(o.x, o.y, o.z); dc.quaternion.set(q.x, q.y, q.z, q.w);
		},
		aimAt(hand, el, winName) { this.aim(hand, this.pointFor(el, winName)); },
		trigger(hand, v) { window.__xrDevice.controllers[hand].updateButtonValue('trigger', v); },
		stick(hand, y) { window.__xrDevice.controllers[hand].updateAxes('thumbstick', 0, y); }
	};
});
const frame = (ms = 400) => sleep(ms);
const click = async (hand = 'right') => { await p.evaluate((h) => __t.trigger(h, 1), hand); await frame(300); await p.evaluate((h) => __t.trigger(h, 0), hand); await frame(400); };

// ---- one rendering path ----
const inv = await p.evaluate(() => {
	const wins = window.__gsVrWindows.windows.map((w) => ({ name: w.name, mesh: w.mesh.name, visible: w.mesh.visible, isCanvasTex: w.texture.isCanvasTexture && w.texture.image === w.canvas, paints: w.paints, w: w.widthM, h: w.heightM, src: w.source.id, srcClass: w.source.classList.contains('html-in-canvas-source') }));
	// Every mesh that renders on the menu layer (1) must be a VR window or the ray visuals.
	const menuLayer = []; scene.traverse((o) => { if (o.isMesh && o.layers.isEnabled(1) && !o.layers.isEnabled(0)) menuLayer.push({ name: o.name, win: !!o.userData.vrWindow, vis: o.visible }); });
	const anyLegacy = []; scene.traverse((o) => { if (o.isMesh && /panel|keyboard|hud|toggle|chat|side|scene/i.test(o.name) && !o.userData.vrWindow) anyLegacy.push(o.name); });
	return { wins, menuLayer, anyLegacy };
});
check('Three VR windows: menu, keyboard, HUD', inv.wins.map((w) => w.name).join() === 'menu,keyboard,hud', inv.wins.map((w) => w.name));
for (const w of inv.wins) check(`Window "${w.name}" is html-in-canvas (CanvasTexture of a painted DOM source #${w.src})`, w.isCanvasTex && !!w.src);
const shown = inv.wins.filter((w) => w.visible).map((w) => w.name);
check('Menu + HUD visible on entering VR, keyboard hidden', shown.join() === 'menu,hud', shown);
for (const w of inv.wins.filter((x) => x.visible)) check(`Window "${w.name}" painted and sized`, w.paints > 0 && w.w > 0.05 && w.h > 0.02, { paints: w.paints, w: +w.w.toFixed(3), h: +w.h.toFixed(3) });
const nonWin = inv.menuLayer.filter((m) => !m.win && !/reticle|ray|pointer|cursor/i.test(m.name) && m.vis);
check('No legacy canvas panels on the menu layer', nonWin.length === 0 && inv.anyLegacy.length === 0, { nonWin, legacy: inv.anyLegacy });
const scale = await p.evaluate(() => { const [m, k, h] = ['menu', 'keyboard', 'hud'].map((n) => __t.win(n)); return { m: m.widthM / m.source.offsetWidth, k: k.widthM / Math.max(1, k.source.offsetWidth), hAng: (h.widthM / h.source.offsetWidth) / 0.85, mAng: (m.widthM / m.source.offsetWidth) / 1.5 }; });
check('Consistent CSS px → angular size across windows', Math.abs(scale.hAng - scale.mAng) / scale.mAng < 0.02, scale);

// ---- contrast ----
await p.evaluate(AUDIT);
const audit = await p.evaluate(() => window.__gsContrastAudit({ backdrop: '#1a1d23', opaqueRoot: true }));
const bad = audit.filter((r) => !r.pass);
check(`Contrast audit: ${audit.length - bad.length}/${audit.length} pairs meet AA (text 4.5, boundaries 3)`, bad.length === 0, bad.map((r) => `${r.name} ${r.ratio}`));
check('Ray hover ring present (amber outline ≥ 2px)', audit.some((r) => r.name === 'Ray hover ring' && r.pass && r.hoverRing));

// ---- contrast of what is actually painted into the window textures ----
// The CSS audit reads computed styles; this samples the texture pixels inside
// each label's box (brightest vs darkest pixel ~ text vs its fill) so a painter
// bug (e.g. HTML text drawn black) cannot hide behind correct CSS.
const painted = await p.evaluate(async () => {
	const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
	const W = window.__gsVrWindows; const out = [];
	const probe = (label, winName, el) => {
		const w = W.byName(winName); if (!el || !w.mesh.visible) return out.push({ label, ratio: 0, missing: true });
		w.tick(true);
		const sr = w.source.getBoundingClientRect(), r = el.getBoundingClientRect(); const k = w.canvas.width / sr.width;
		const x = Math.round((r.left - sr.left + 9) * k), y = Math.round((r.top - sr.top + 4) * k), ww = Math.max(1, Math.round((r.width - 18) * k)), hh = Math.max(1, Math.round((r.height - 8) * k));
		const d = w.canvas.getContext('2d').getImageData(x, y, ww, hh).data; let lo = 1, hi = 0;
		for (let i = 0; i < d.length; i += 4) { const L = lum(d[i], d[i + 1], d[i + 2]); if (L < lo) lo = L; if (L > hi) hi = L; }
		out.push({ label, ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2) });
	};
	const q = (s) => document.querySelector(s);
	probe('Header title', 'menu', q('#desktop-chat-header span, #desktop-chat-header'));
	probe('Selected tab label', 'menu', q('.dchat-tab.active'));
	probe('Unselected tab label', 'menu', q('.dchat-tab:not(.active)'));
	probe('Selected sub-tab label', 'menu', q('.dchat-subtab.active'));
	probe('Unselected sub-tab label', 'menu', q('.dchat-subtab:not(.active)'));
	probe('Send button label', 'menu', q('#desktop-send-button'));
	probe('Assistant message', 'menu', q('.dchat-msg.assistant'));
	probe('HUD button label', 'hud', q('#gs-vr-hud-toggle'));
	return out;
});
for (const r of painted) check(`Painted contrast: ${r.label} ≥ 4.5:1 in the VR texture`, r.ratio >= 4.5, r.ratio);

// ---- ray: hover + click on the menu (switch to the Controls tab) ----
const tabSel = '.dchat-tab[data-tab="controls"]';
await p.evaluate((s) => __t.aimAt('right', document.querySelector(s), 'menu'), tabSel);
await frame(600);
const hov = await p.evaluate((s) => ({ el: document.querySelector(s).classList.contains('gs-ray-hover'), reticle: (() => { let r = null; scene.traverse((o) => { if (/reticle/i.test(o.name) && o.visible) r = o.material && o.material.color && o.material.color.getHex(); }); return r; })() }), tabSel);
check('Ray hover highlights the element under the ray (menu)', hov.el);
await click();
check('Ray click on menu switches tab', await p.evaluate((s) => document.querySelector(s).classList.contains('active'), tabSel));

// ---- Fixed / Follow via the ray ----
const followBtn = await p.evaluate(() => !!document.querySelector('#dchat-window-anchor [data-window-anchor="follow"]'));
if (followBtn) {
	await p.evaluate(() => { const el = document.querySelector('#dchat-window-anchor [data-window-anchor="follow"]'); el.scrollIntoView({ block: 'center' }); });
	await frame(500);
	await p.evaluate(() => __t.aimAt('right', document.querySelector('#dchat-window-anchor [data-window-anchor="follow"]'), 'menu'));
	await frame(400); await click();
	const isFollow = await p.evaluate(() => document.querySelector('#dchat-window-anchor [data-window-anchor="follow"]').classList.contains('active'));
	check('Ray click selects Follow', isFollow);
	await p.evaluate(() => { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)); window.__xrDevice.controllers.right.position.set(0, -5, 0); window.__xrDevice.quaternion.set(q.x, q.y, q.z, q.w); });
	await sleep(3500);
	const fp = await p.evaluate(() => { const v = new THREE.Vector3(); __t.win('menu').mesh.getWorldPosition(v); return { x: v.x, z: v.z }; });
	check('Follow: menu swings to where the head turned (left)', fp.x < -0.8, { x: +fp.x.toFixed(2), z: +fp.z.toFixed(2) });
	await p.evaluate(() => window.__xrDevice.quaternion.set(0, 0, 0, 1));
	await sleep(3500);
	await p.evaluate(() => __t.aimAt('right', document.querySelector('#dchat-window-anchor [data-window-anchor="fixed"]'), 'menu'));
	await frame(400); await click();
	check('Ray click selects Fixed', await p.evaluate(() => document.querySelector('#dchat-window-anchor [data-window-anchor="fixed"]').classList.contains('active')));
	await p.evaluate(() => { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)); window.__xrDevice.quaternion.set(q.x, q.y, q.z, q.w); });
	await sleep(1500);
	const fx = await p.evaluate(() => { const v = new THREE.Vector3(); __t.win('menu').mesh.getWorldPosition(v); return { x: v.x, z: v.z }; });
	check('Fixed: menu stays put when the head turns', Math.abs(fx.x) < 0.3, { x: +fx.x.toFixed(2), z: +fx.z.toFixed(2) });
	await p.evaluate(() => window.__xrDevice.quaternion.set(0, 0, 0, 1));
	await sleep(800);
} else check('Fixed/Follow control present', false);

// ---- lay-down: view upright after load ----
check('View is upright (no lay-down pitch) in VR', await p.evaluate(() => { let o = camera.parent; let maxX = 0; while (o) { maxX = Math.max(maxX, Math.abs(o.rotation.x)); o = o.parent; } return maxX < 1e-6; }));

// ---- ray: drag-scroll + thumbstick scroll on the chat log ----
await p.evaluate(() => document.querySelector('.dchat-tab[data-tab="chat"]')?.click());
await frame(300);
await p.evaluate(() => { const m = document.getElementById('desktop-chat-messages'); for (let i = 0; i < 40; i++) { const d = document.createElement('div'); d.className = 'dchat-msg assistant'; d.textContent = 'Line ' + i + ' of a long conversation used to test scrolling.'; m.appendChild(d); } m.scrollTop = m.scrollHeight; });
await frame(500);
const msgs = '#desktop-chat-messages';
const top0 = await p.evaluate((s) => document.querySelector(s).scrollTop, msgs);
await p.evaluate((s) => __t.aimAt('right', document.querySelector(s), 'menu'), msgs);
await frame(400);
await p.evaluate(() => __t.trigger('right', 1)); await frame(300);
await p.evaluate(() => { const w = __t.win('menu'); const el = document.getElementById('desktop-chat-messages'); const pt = __t.pointFor(el, 'menu'); pt.y -= 0.18; __t.aim('right', pt); });
await frame(500);
await p.evaluate(() => __t.trigger('right', 0)); await frame(300);
const top1 = await p.evaluate((s) => document.querySelector(s).scrollTop, msgs);
check('Trigger-drag scrolls the chat log', top1 < top0 - 30, { before: top0, after: top1 });
// Right grip cycles locomotion free -> off (thumbsticks then scroll).
await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 1)); await frame(300);
await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('squeeze', 0)); await frame(300);
await p.evaluate((s) => __t.aimAt('right', document.querySelector(s), 'menu'), msgs);
await frame(300);
await p.evaluate(() => __t.stick('right', 1)); await frame(700); await p.evaluate(() => __t.stick('right', 0)); await frame(200);
const top2 = await p.evaluate((s) => document.querySelector(s).scrollTop, msgs);
check('Thumbstick (locomotion off) scrolls under the ray', top2 > top1 + 30, { before: top1, after: top2 });

// ---- ray: typing via the in-scene keyboard ----
await p.evaluate(() => __t.aimAt('right', document.getElementById('desktop-chat-input'), 'menu'));
await frame(400); await click();
const kb = await p.evaluate(() => ({ open: __t.win('keyboard').mesh.visible, typing: document.getElementById('desktop-chat-input').classList.contains('gs-vr-typing') }));
check('Ray click on chat input opens the keyboard window', kb.open);
check('Typing target shows the focus ring', kb.typing);
for (const ch of ['h', 'i']) {
	await p.evaluate((c) => { const k = [...document.querySelectorAll('#gs-vr-keyboard [data-kb-value]')].find((e) => e.dataset.kbValue.toLowerCase() === c); __t.aimAt('right', k, 'keyboard'); }, ch);
	await frame(400);
	if (ch === 'h') check('Ray hover highlights keys on the keyboard window', await p.evaluate(() => !!document.querySelector('#gs-vr-keyboard .gs-ray-hover')));
	await click();
}
const typed = await p.evaluate(() => document.getElementById('desktop-chat-input').value);
check('Ray clicks on keyboard keys type into the field', /hi$/i.test(typed), typed);
await p.evaluate(() => __t.aimAt('right', document.querySelector('#gs-vr-keyboard .gs-vr-kb-done'), 'keyboard'));
await frame(400); await click();
check('Done closes the keyboard', await p.evaluate(() => !__t.win('keyboard').mesh.visible));

// ---- ray: HUD Hide/Show UI ----
await p.evaluate(() => __t.aimAt('right', document.getElementById('gs-vr-hud-toggle'), 'hud'));
await frame(500);
check('Ray hover highlights the HUD button', await p.evaluate(() => document.getElementById('gs-vr-hud-toggle').classList.contains('gs-ray-hover')));
await click();
check('HUD click hides the menu window', await p.evaluate(() => !__t.win('menu').mesh.visible && document.getElementById('gs-vr-hud-toggle').getAttribute('aria-pressed') === 'true'));
await click();
check('HUD click shows it again', await p.evaluate(() => __t.win('menu').mesh.visible));

// ---- exit ----
await p.evaluate(() => renderer.xr.getSession()?.end());
await sleep(1000);
check('Leaving VR hides all VR windows', await p.evaluate(() => window.__gsVrWindows.windows.every((w) => !w.mesh.visible)));
check('No console errors', errors.length === 0, errors.slice(0, 5));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
