// Origin rotation (Environment tab) headless test.
//   BASE=http://localhost:3842 node test.mjs        (vercel-sim: needed for the share round trip)
//   SHOT_DIR=/workspace/gs-origin-shots ONLY=desktop|phone|vr|share node test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:3842';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/gs-origin-shots';
const ONLY = process.env.ONLY || '';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, c, e = '') => { results.push(`${c ? 'PASS' : 'FAIL'} ${n}${e ? ' — ' + e : ''}`); console.log(results.at(-1)); };
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const near3 = (a, b, eps = 0.02) => a.every((v, i) => near(v, b[i], eps));
const isSnapped = (r, step = 15) => ['yaw', 'pitch', 'roll'].every((k) => Math.abs(r[k] / step - Math.round(r[k] / step)) < 1e-6);
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { width: 1280, height: 860 };
const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const BOX_CODE = "const m = new THREE.Mesh(new THREE.BoxGeometry(0.4,0.4,0.4), new THREE.MeshStandardMaterial({color:0xff5533})); m.name='box'; m.position.set(0,0.25,-2); scene.add(m);\nconst g = new THREE.GridHelper(6, 12, 0x99a, 0x556); g.name='grid'; scene.add(g);";

async function open(vp, { ctx = null, path = '/', xr = false, clear = true } = {}) {
  const context = ctx || await b.createBrowserContext();
  const p = await context.newPage(); p._errs = [];
  p.on('pageerror', (e) => p._errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ollama|11434/i.test(m.text())) p._errs.push(m.text().slice(0, 200)); });
  if (vp.isMobile) await p.setUserAgent(UA_PHONE);
  await p.setViewport(vp);
  if (xr) await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/chat') { p._chat = p._chat || []; p._chat.push(JSON.parse(req.postData())); return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) }); }
    if (u.pathname === '/api/backends') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ backends: { claude: { label: 'Claude', provider: 'claude', available: true } }, default: 'claude' }) });
    req.continue();
  });
  if (clear) await p.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('__o')) { sessionStorage.setItem('__o', '1'); localStorage.removeItem('gs.originRotation'); localStorage.setItem('gs.publishCreationContext', JSON.stringify({ include: false, files: false })); } });
  await p.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }); await p.waitForFunction(() => window.gsSessionCode && window.gsOrigin, { timeout: 30000 }); await sleep(2000);
  p._ctx = context;
  return p;
}
const tab = async (p, t) => { await p.evaluate((t) => document.querySelector(`.dchat-tab[data-tab="${t}"]`).click(), t); await sleep(300); };
async function showGizmo(p) {
  await tab(p, 'env');
  await p.evaluate(() => document.getElementById('dchat-origin').scrollIntoView({ block: 'center' }));
  await sleep(250);
  return p.evaluate(() => { const r = document.getElementById('dchat-origin-gizmo').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
}
const rot = (p) => p.evaluate(() => gsOrigin.rotation);
const state = (p) => p.evaluate(() => {
  const box = scene.getObjectByName('box'); const w = new THREE.Vector3();
  if (box) box.getWorldPosition(w);
  return { rot: gsOrigin.rotation, parent: box?.parent?.name || (box?.parent === scene ? 'scene' : null), local: box ? box.position.toArray() : null, world: w.toArray(), readout: document.getElementById('dchat-origin-readout').textContent,
    inputs: ['yaw', 'pitch', 'roll'].map((k) => document.getElementById('dchat-origin-' + k).value) };
});
async function mouseDrag(p, from, to, steps = 12, shift = false) {
  if (shift) await p.keyboard.down('Shift');
  await p.mouse.move(from[0], from[1]); await p.mouse.down();
  for (let i = 1; i <= steps; i++) await p.mouse.move(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps);
  await p.mouse.up();
  if (shift) await p.keyboard.up('Shift');
  await sleep(100);
}
async function touchDrag(p, from, to, steps = 12) {
  const cdp = await p.createCDPSession();
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from[0], from[1]) });
  for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps) }); await sleep(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach(); await sleep(150);
}
async function touchTap(p, x, y) { await touchDrag(p, [x, y], [x, y], 1); }
async function setInput(p, k, v, viaTouch) {
  const sel = '#dchat-origin-' + k;
  await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
  if (viaTouch) { const r = await p.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }); await touchTap(p, r[0], r[1]); }
  await p.click(sel, { clickCount: 3 });
  await p.keyboard.press('Backspace');
  await p.type(sel, String(v)); await p.keyboard.press('Enter'); await sleep(150);
}

// ---------------------------------------------------------------- desktop / phone
for (const [name, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
  if (ONLY && ONLY !== name) continue;
  const H = `[${name}]`; const touch = !!vp.hasTouch;
  const drag = touch ? touchDrag : (p, a, z) => mouseDrag(p, a, z);
  const p = await open(vp);
  if (touch) ok(`${H} html.gs-phone layout on`, await p.evaluate(() => document.documentElement.classList.contains('gs-phone')));
  await p.evaluate((c) => gsSessionCode.add(c), BOX_CODE); await sleep(400);
  let g = await showGizmo(p);
  let s = await state(p);
  ok(`${H} gizmo shown in Environment tab`, g.w >= 150 && g.h >= 150, JSON.stringify(g));
  ok(`${H} starts unrotated, content stays on the scene root`, s.readout === 'Not rotated' && s.parent === 'scene' && near3(s.world, [0, 0.25, -2]), JSON.stringify(s));
  const labels = await p.evaluate(() => gsOrigin._gizmo.axisEndPoints().map((e) => (e.sign > 0 ? '' : '-') + e.id.toUpperCase()).sort().join(','));
  ok(`${H} six labelled axis ends`, labels === '-X,-Y,-Z,X,Y,Z', labels);
  if (touch) {
    const sizes = await p.evaluate(() => ['yaw', 'pitch', 'roll', 'reset'].map((k) => { const r = document.getElementById('dchat-origin-' + k).getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); }).concat([Math.round(document.querySelector('label[for="dchat-origin-snap"], #dchat-origin-snap')?.closest('label')?.getBoundingClientRect().height || 0)]));
    ok(`${H} inputs / reset / snap toggle are ≥44px tap targets`, sizes.every((v) => v >= 44), JSON.stringify(sizes));
  }
  await p.screenshot({ path: `${SHOT_DIR}/${name}-env-unrotated.png` });

  // ball drag (trackball)
  await drag(p, [g.cx - 10, g.cy - 8], [g.cx + 40, g.cy + 22]);
  s = await state(p);
  ok(`${H} ${touch ? 'touch' : 'mouse'} drag on the ball rotates the origin`, Math.abs(s.rot.yaw) > 10 && Math.abs(s.rot.pitch) > 5, JSON.stringify(s.rot));
  ok(`${H} content adopted into gsOriginRoot, local transform kept, world turned`, s.parent === 'gsOriginRoot' && near3(s.local, [0, 0.25, -2]) && !near3(s.world, [0, 0.25, -2], 0.05), JSON.stringify(s));
  ok(`${H} readout + numeric fields follow the drag`, /^Yaw -?\d/.test(s.readout) && Number(s.inputs[0]) === Math.round(s.rot.yaw * 10) / 10, s.readout + ' ' + s.inputs);
  ok(`${H} drag not snapped by default`, !isSnapped(s.rot), JSON.stringify(s.rot));

  // ring drag (roll)
  await p.evaluate(() => gsOrigin.reset()); g = await showGizmo(p);
  const rr = g.w * 0.44;
  const ringPts = (a0, a1) => [[g.cx + Math.cos(a0) * rr, g.cy + Math.sin(a0) * rr], [g.cx + Math.cos(a1) * rr, g.cy + Math.sin(a1) * rr]];
  {
    const [a, z] = ringPts(-Math.PI / 2, -Math.PI / 2 + 0.7);
    if (touch) await touchDrag(p, a, z, 10);
    else { await p.mouse.move(a[0], a[1]); await p.mouse.down(); for (let i = 1; i <= 10; i++) { const t = -Math.PI / 2 + 0.07 * i; await p.mouse.move(g.cx + Math.cos(t) * rr, g.cy + Math.sin(t) * rr); } await p.mouse.up(); await sleep(100); }
  }
  s = await state(p);
  ok(`${H} drag on the ring rolls (about the view axis)`, Math.abs(s.rot.roll) > 20 && Math.abs(s.rot.roll) < 60 && Math.abs(s.rot.pitch) < 25, JSON.stringify(s.rot));
  await p.screenshot({ path: `${SHOT_DIR}/${name}-env-rolled.png` });

  // snapping
  await p.evaluate(() => gsOrigin.reset()); g = await showGizmo(p);
  if (!touch) {
    await mouseDrag(p, [g.cx - 10, g.cy - 8], [g.cx + 37, g.cy + 19], 12, true);
    s = await state(p);
    ok(`${H} Shift-drag snaps to 15°`, isSnapped(s.rot) && !s.readout.includes('Not'), JSON.stringify(s.rot));
    await p.evaluate(() => gsOrigin.reset());
  }
  if (touch) { const r = await p.$eval('#dchat-origin-snap', (e) => { e.closest('label').scrollIntoView({ block: 'center' }); const b = e.closest('label').getBoundingClientRect(); return [b.left + 12, b.top + b.height / 2]; }); await touchTap(p, r[0], r[1]); }
  else await p.click('#dchat-origin-snap');
  ok(`${H} Snap 15° toggle turns on`, await p.evaluate(() => gsOrigin._gizmo.snap === true && document.getElementById('dchat-origin-snap').checked));
  g = await showGizmo(p);
  await drag(p, [g.cx - 10, g.cy - 8], [g.cx + 33, g.cy + 27]);
  s = await state(p);
  ok(`${H} drag with the Snap toggle snaps to 15°`, isSnapped(s.rot) && !s.readout.includes('Not'), JSON.stringify(s.rot));
  await setInput(p, 'yaw', 37, touch);
  ok(`${H} typed value snaps too while Snap is on (37 → 30)`, (await rot(p)).yaw === 30, JSON.stringify(await rot(p)));
  if (touch) { const r = await p.$eval('#dchat-origin-snap', (e) => { e.closest('label').scrollIntoView({ block: 'center' }); const b = e.closest('label').getBoundingClientRect(); return [b.left + 12, b.top + b.height / 2]; }); await touchTap(p, r[0], r[1]); } else await p.click('#dchat-origin-snap');
  ok(`${H} Snap toggle turns off`, await p.evaluate(() => gsOrigin._gizmo.snap === false), await p.evaluate(() => { const r = document.getElementById('dchat-origin-snap').closest('label').getBoundingClientRect(); return JSON.stringify([r.left, r.top, r.width, r.height, innerHeight, visualViewport.height, document.activeElement?.id]); }));

  // numeric input
  await p.evaluate(() => gsOrigin.reset());
  await setInput(p, 'yaw', 90, touch);
  s = await state(p);
  ok(`${H} typing yaw 90 turns the scene a quarter turn`, s.rot.yaw === 90 && s.rot.pitch === 0 && near3(s.world, [-2, 0.25, 0]), JSON.stringify(s));
  await setInput(p, 'pitch', 120, touch);
  ok(`${H} pitch is clamped to ±90`, (await rot(p)).pitch === 90);
  await setInput(p, 'roll', -200, touch);
  ok(`${H} roll wraps to ±180 (−200 → 160)`, (await rot(p)).roll === 160, JSON.stringify(await rot(p)) + ' field=' + await p.$eval('#dchat-origin-roll', (e) => e.value));
  await setInput(p, 'pitch', 'abc', false);
  ok(`${H} junk input ignored`, (await rot(p)).pitch === 90 && (await p.$eval('#dchat-origin-pitch', (e) => e.value)) === '90');

  // click an axis end → align it
  await p.evaluate(() => gsOrigin.set({ yaw: 20, pitch: 10, roll: 5 }));
  g = await showGizmo(p);
  const ends = await p.evaluate(() => gsOrigin._gizmo.axisEndPoints());
  const xEnd = ends.find((e) => e.id === 'x' && e.sign > 0);
  if (touch) await touchTap(p, xEnd.x, xEnd.y); else { await p.mouse.click(xEnd.x, xEnd.y); await sleep(100); }
  const al = await p.evaluate(() => {
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(gsOrigin.root.getWorldQuaternion(new THREE.Quaternion()));
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    return { rot: gsOrigin.rotation, dot: ax.dot(back), cardinal: Math.max(Math.abs(ax.x), Math.abs(ax.y), Math.abs(ax.z)) };
  });
  ok(`${H} ${touch ? 'tapping' : 'clicking'} the X end turns +X toward the viewer, squared to 90°`, al.dot > 0.6 && al.cardinal > 0.999 && isSnapped(al.rot, 90), JSON.stringify(al));
  const yEnd = (await p.evaluate(() => gsOrigin._gizmo.axisEndPoints())).find((e) => e.id === 'y' && e.sign < 0);
  if (touch) await touchTap(p, yEnd.x, yEnd.y); else { await p.mouse.click(yEnd.x, yEnd.y); await sleep(100); }
  const al2 = await p.evaluate(() => { const ax = new THREE.Vector3(0, -1, 0).applyQuaternion(gsOrigin.root.getWorldQuaternion(new THREE.Quaternion())); const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())); return { dot: ax.dot(back), rot: gsOrigin.rotation }; });
  ok(`${H} hollow −Y end aligns −Y toward the viewer`, al2.dot > 0.6, JSON.stringify(al2));

  // reset
  await p.evaluate(() => gsOrigin.set({ yaw: 45, pitch: 30, roll: 0 }));
  if (touch) { await p.evaluate(() => document.getElementById('dchat-origin-reset').scrollIntoView({ block: 'center' })); const r = await p.$eval('#dchat-origin-reset', (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }); await touchTap(p, r[0], r[1]); }
  else await p.click('#dchat-origin-reset');
  s = await state(p);
  ok(`${H} Reset origin → unrotated, world = scene coordinates`, s.readout === 'Not rotated' && s.inputs.join() === '0,0,0' && near3(s.world, [0, 0.25, -2]), JSON.stringify(s));

  // persistence across reload
  await p.evaluate(() => gsOrigin.set({ yaw: -60, pitch: 15, roll: 30 }));
  await p.reload({ waitUntil: 'networkidle2' }); await p.waitForFunction(() => window.gsSessionCode && window.gsOrigin, { timeout: 30000 }); await sleep(1500);
  await p.evaluate((c) => gsSessionCode.add(c), BOX_CODE); await sleep(500);
  g = await showGizmo(p);
  s = await state(p);
  ok(`${H} rotation persists across reload (fields + readout)`, s.rot.yaw === -60 && s.rot.pitch === 15 && s.rot.roll === 30 && s.inputs.join() === '-60,15,30' && s.readout.startsWith('Yaw -60'), JSON.stringify(s));
  ok(`${H} content added after reload is adopted under the rotation`, s.parent === 'gsOriginRoot' && near3(s.local, [0, 0.25, -2]), JSON.stringify(s));
  await p.screenshot({ path: `${SHOT_DIR}/${name}-env-rotated.png` });

  // scene.remove still works on adopted objects; getObjectByName finds them
  const rm = await p.evaluate(() => { const o = scene.getObjectByName('box'); scene.remove(o); return !scene.getObjectByName('box'); });
  ok(`${H} scene.remove(obj) removes adopted content`, rm);

  // Orbit target stays at the scene origin and orbit drag still works
  if (!touch) {
    await p.evaluate(() => gsControls.setMode('orbit'));
    const before = await p.evaluate(() => ({ t: gsControls.controls.target.toArray(), c: camera.position.toArray(), d: camera.position.length() }));
    await p.evaluate(() => { const d = document.getElementById('desktop-chat'); d.style.visibility = 'hidden'; });
    await mouseDrag(p, [900, 500], [1050, 460], 15);
    await sleep(300);
    const after = await p.evaluate(() => ({ t: gsControls.controls.target.toArray(), c: camera.position.toArray(), d: camera.position.distanceTo(gsControls.controls.target), o: gsOrigin.root.getWorldPosition(new THREE.Vector3()).toArray() }));
    await p.evaluate(() => { document.getElementById('desktop-chat').style.visibility = ''; });
    ok(`${H} Orbit target is still the origin, which the rotation pivots on`, near3(after.t, [0, 0, 0], 1e-6) && near3(after.o, [0, 0, 0], 1e-6), JSON.stringify(after));
    ok(`${H} Orbit drag still orbits (camera moved, distance kept)`, !near3(before.c, after.c, 0.05) && near(after.d, before.d, 0.05), JSON.stringify({ before, after }));
    ok(`${H} orbiting redraws the gizmo axes`, await p.evaluate(() => { const e = gsOrigin._gizmo.axisEndPoints(); return e.length === 6; }));
  }

  // export bakes the rotation in
  await p.evaluate((c) => gsSessionCode.add(c), BOX_CODE); await sleep(400);
  await p.evaluate(() => gsOrigin.set({ yaw: 90, pitch: 0, roll: 0 }));
  const exp = await p.evaluate(async () => {
    const r = await gsSceneExport.exportGLB(); const buf = new Uint8Array(await r.blob.arrayBuffer());
    const dv = new DataView(buf.buffer); const len = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + len)));
    const n = json.nodes.find((x) => x.name === 'box'); window.__nodes = json.nodes;
    const names = json.nodes.map((x) => x.name);
    return { t: n?.translation || (n?.matrix && n.matrix.slice(12, 15)), xAxis: n?.matrix && n.matrix.slice(0, 3), names, meshes: r.meshCount, nodes: json.nodes };
  });
  ok(`${H} GLB export bakes the rotation (box at world -2,0.25,0, turned 90°)`, exp.t && near3(exp.t, [-2, 0.25, 0], 1e-3) && (!exp.xAxis || near3(exp.xAxis, [0, 0, -1], 1e-3)), JSON.stringify(exp.nodes));
  ok(`${H} GLB export has no gsOriginRoot / system nodes`, !exp.names.includes('gsOriginRoot') && !exp.names.includes('htmlInCanvasPanel'), JSON.stringify(exp.names));
  await p.evaluate(() => gsOrigin.reset());
  const exp0 = await p.evaluate(async () => { const r = await gsSceneExport.exportGLB(); const buf = new Uint8Array(await r.blob.arrayBuffer()); const dv = new DataView(buf.buffer); const len = dv.getUint32(12, true); const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + len))); const n = json.nodes.find((x) => x.name === 'box'); return n?.translation || (n?.matrix ? n.matrix.slice(12, 15) : [0, 0, 0]); });
  ok(`${H} after Reset the export is in scene coordinates again`, exp0 && near3(exp0, [0, 0.25, -2], 1e-3), JSON.stringify(exp0));

  // AI settings note mentions the rotation only while rotated
  const sendChat = async (text) => {
    await tab(p, 'chat'); const n = (p._chat || []).length;
    await p.click('#desktop-chat-input'); await p.type('#desktop-chat-input', text); await p.click('#desktop-send-button');
    for (let i = 0; i < 40 && (p._chat || []).length === n; i++) await sleep(100);
    await sleep(500); return JSON.stringify((p._chat || []).at(-1)?.messages || []);
  };
  const n0 = await sendChat('hello');
  await p.evaluate(() => gsOrigin.set({ yaw: 30, pitch: 0, roll: 0 }));
  const n1 = await sendChat('add a tree');
  await p.evaluate(() => gsOrigin.reset());
  ok(`${H} AI settings note mentions the origin rotation only while rotated`, !/Origin rotation:/.test(n0) && /Origin rotation: the user turned the scene's frame \(yaw 30/.test(n1), n1.slice(0, 120));
  ok(`${H} no console/page errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 5)));
  await p._ctx.close();
}

// ---------------------------------------------------------------- physics + hot reload
if (!ONLY || ONLY === 'physics') {
  const H = '[physics]';
  const p = await open(DESKTOP);
  await p.evaluate(() => gsOrigin.set({ yaw: 0, pitch: 0, roll: 90 }));
  const AMMO = "const Ammo = await gsRequire('ammo');\nwindow.physicsWorld ??= (() => { const cfg = new Ammo.btDefaultCollisionConfiguration(); const w = new Ammo.btDiscreteDynamicsWorld(new Ammo.btCollisionDispatcher(cfg), new Ammo.btDbvtBroadphase(), new Ammo.btSequentialImpulseConstraintSolver(), cfg); w.setGravity(new Ammo.btVector3(0,-9.8,0)); return w; })();\nconst world = window.physicsWorld;\nconst shape = new Ammo.btSphereShape(0.2);\nconst t = new Ammo.btTransform(); t.setIdentity(); t.setOrigin(new Ammo.btVector3(0.5,3,-2));\nconst inertia = new Ammo.btVector3(0,0,0); shape.calculateLocalInertia(1, inertia);\nconst body = new Ammo.btRigidBody(new Ammo.btRigidBodyConstructionInfo(1, new Ammo.btDefaultMotionState(t), shape, inertia));\nworld.addRigidBody(body); gs.onDispose(() => world.removeRigidBody(body));\nconst mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshStandardMaterial({color:0xff0000})); mesh.name='ammoBall'; mesh.userData.physicsBody = body; mesh.position.set(0.5,3,-2); scene.add(mesh);\nconst tmp = new Ammo.btTransform();\ngs.onUpdate(() => { world.stepSimulation(1/60, 10); body.getMotionState().getWorldTransform(tmp); const o = tmp.getOrigin(); mesh.position.set(o.x(), o.y(), o.z()); });";
  await p.evaluate((c) => gsSessionCode.add(c), AMMO); await sleep(700);
  const ph = await p.evaluate(() => { const m = scene.getObjectByName('ammoBall'); const w = m.getWorldPosition(new THREE.Vector3()); return { parent: m.parent.name, local: m.position.toArray(), world: w.toArray(), back: gsOrigin.toLocal(w).toArray() }; });
  ok(`${H} ammo body falls in the scene's own frame (local y drops, x/z kept)`, ph.parent === 'gsOriginRoot' && ph.local[1] < 2.9 && near(ph.local[0], 0.5, 0.01) && near(ph.local[2], -2, 0.01), JSON.stringify(ph));
  ok(`${H} mesh shown at the rotated spot (roll 90: world x = −local y)`, near(ph.world[0], -ph.local[1], 0.01) && near(ph.world[1], ph.local[0], 0.01), JSON.stringify(ph));
  ok(`${H} gsOrigin.toLocal(world) round-trips`, near3(ph.back, ph.local, 1e-4));
  // hot reload: edit the block in the Code tab, the body keeps its (local) transform
  await tab(p, 'code');
  const preY = await p.evaluate(() => scene.getObjectByName('ammoBall').position.y);
  await p.evaluate(() => { const ed = document.getElementById('dchat-code-editor'); ed.value = ed.value.replace('color:0xff0000', 'color:0x00ff00'); ed.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.click('#dchat-code-apply'); await sleep(900);
  const hr = await p.evaluate(() => { const m = scene.getObjectByName('ammoBall'); return { parent: m.parent.name, local: m.position.toArray(), color: m.material.color.getHex(), count: gsOrigin.root.children.filter((c) => c.name === 'ammoBall').length + scene.children.filter((c) => c.name === 'ammoBall').length }; });
  ok(`${H} hot reload keeps the falling body where it was (no jump back to the start / no world-space jump)`, hr.color === 0x00ff00 && hr.count === 1 && hr.parent === 'gsOriginRoot' && hr.local[1] <= preY + 0.05 && near(hr.local[0], 0.5, 0.05), JSON.stringify({ preY, hr }));
  ok(`${H} no console/page errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 5)));
  await p._ctx.close();
}

// ---------------------------------------------------------------- share link round trip
if (!ONLY || ONLY === 'share') {
  const H = '[share]';
  const a = await open(DESKTOP);
  await a.evaluate((c) => gsSessionCode.add(c), BOX_CODE); await sleep(300);
  await a.evaluate(() => gsOrigin.set({ yaw: 30, pitch: 15, roll: -45 }));
  const posted = [];
  a.on('request', (r) => { if (r.url().endsWith('/api/community-scenes') && r.method() === 'POST') posted.push(JSON.parse(r.postData())); });
  await tab(a, 'share');
  await a.evaluate(() => document.querySelector('#dchat-share [data-share="link"]').click());
  for (let i = 0; i < 40 && !posted.length; i++) await sleep(150);
  await sleep(800);
  ok(`${H} uploaded scene carries originRotation`, posted.length === 1 && JSON.stringify(posted[0].originRotation) === JSON.stringify({ yaw: 30, pitch: 15, roll: -45 }), JSON.stringify(posted[0]?.originRotation));
  const link = await a.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value).find((v) => /\/e\/[A-Za-z0-9_-]+/.test(v)) || null);
  const id = link ? link.split('/e/')[1] : null;
  ok(`${H} share modal shows an /e/ link`, !!id, link);
  // sharing again unchanged reuses the link; changing the rotation uploads a new one
  await a.evaluate(() => document.querySelector('#gs-share-modal .gs-share-close, #gs-share-modal [data-close], .gs-share-modal-close')?.click());
  await a.evaluate(() => document.querySelector('#dchat-share [data-share="link"]').click()); await sleep(800);
  ok(`${H} unchanged scene reuses the link`, posted.length === 1, String(posted.length));
  await a.evaluate(() => gsOrigin.set({ yaw: 31, pitch: 15, roll: -45 }));
  await a.evaluate(() => document.querySelector('#dchat-share [data-share="link"]').click());
  for (let i = 0; i < 40 && posted.length < 2; i++) await sleep(150);
  ok(`${H} changing only the rotation makes a new share`, posted.length === 2 && posted[1].originRotation?.yaw === 31, String(posted.length));
  await a._ctx.close();
  // fresh browser: /e/:id opens rotated
  if (id) {
    const v = await open(DESKTOP, { path: '/e/' + id });
    await sleep(1500);
    const s = await state(v);
    ok(`${H} /e/:id in a fresh browser restores the rotation`, s.rot.yaw === 30 && s.rot.pitch === 15 && s.rot.roll === -45, JSON.stringify(s.rot));
    ok(`${H} shared content sits under the rotated origin at the same world spot`, s.parent === 'gsOriginRoot' && near3(s.local, [0, 0.25, -2]), JSON.stringify(s));
    await showGizmo(v);
    await v.screenshot({ path: `${SHOT_DIR}/share-opened-rotated.png` });
    ok(`${H} no console/page errors (viewer)`, v._errs.length === 0, JSON.stringify(v._errs.slice(0, 5)));
    // and a second fresh browser with its own saved rotation still gets the scene's
    await v._ctx.close();
  }
  // old scene without the field → unrotated, even if this browser had a rotation saved
  const old = await fetch(BASE + '/api/community-scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Old scene (pre-0.98)', codeBlocks: [BOX_CODE] }) }).then((r) => r.json());
  const oldId = old.id || old.scene?.id;
  const ctx = await b.createBrowserContext();
  const pre = await open(DESKTOP, { ctx }); await pre.evaluate(() => gsOrigin.set({ yaw: 70, pitch: 0, roll: 0 })); await pre.close();
  const o = await open(DESKTOP, { ctx, path: '/e/' + oldId, clear: false }); await sleep(1500);
  const so = await state(o);
  ok(`${H} old scene (no originRotation) opens unrotated`, !!oldId && so.readout === 'Not rotated' && near3(so.world, [0, 0.25, -2]), JSON.stringify(so));
  ok(`${H} no console/page errors (old scene)`, o._errs.length === 0, JSON.stringify(o._errs.slice(0, 5)));
  await ctx.close();
}

// ---------------------------------------------------------------- VR (IWER Quest 3): controller ray drag on the mirrored menu
if (!ONLY || ONLY === 'vr') {
  const H = '[vr]';
  const p = await open({ width: 1600, height: 900 }, { xr: true });
  await p.evaluate((c) => gsSessionCode.add(c), BOX_CODE);
  await p.click('#XRButton').catch(() => {});
  for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
  ok(`${H} entered immersive session`, await p.evaluate(() => renderer.xr.isPresenting));
  await sleep(1500);
  await p.evaluate(() => { const d = window.__xrDevice; d.position.set(0, 1.6, 0.35); d.quaternion.set(0, 0, 0, 1); });
  // The Env tab reaches VR through the "HTML in canvas" menu (the side panel's toggle); press it with the ray.
  const aimAtSide = () => p.evaluate(() => {
    let side = null; scene.traverse((o) => { if (o.isMesh && o.geometry?.parameters?.width === 0.3 && o.material?.map?.image?.getContext) side = o; });
    const img = side.material.map.image; const u = 0.5, v = 1 - 156 / img.height;
    const target = side.localToWorld(new THREE.Vector3((u - 0.5) * 0.3, (v - 0.5) * side.geometry.parameters.height, 0));
    const c = window.__xrDevice.controllers.right; const from = new THREE.Vector3(0.15, 1.3, 0.2); c.position.set(from.x, from.y, from.z);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(from, target, new THREE.Vector3(0, 1, 0))); c.quaternion.set(q.x, q.y, q.z, q.w);
    return !!side;
  });
  await aimAtSide(); await sleep(300);
  await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 1)); await sleep(200);
  await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 0)); await sleep(800);
  ok(`${H} HTML-in-canvas menu switched on with the ray`, await p.evaluate(() => scene.getObjectByName('htmlInCanvasPanel').visible));
  await tab(p, 'env');
  await p.evaluate(() => document.getElementById('dchat-origin').scrollIntoView({ block: 'center' })); await sleep(1200);
  // aim the right controller at a pixel of the mirrored menu
  const aim = async (dxPx, dyPx) => p.evaluate((dxPx, dyPx) => {
    const panel = scene.getObjectByName('htmlInCanvasPanel');
    const dc = document.getElementById('desktop-chat').getBoundingClientRect();
    const gr = document.getElementById('dchat-origin-gizmo').getBoundingClientRect();
    const u = (gr.left + gr.width / 2 + dxPx - dc.left) / dc.width, v = 1 - (gr.top + gr.height / 2 + dyPx - dc.top) / dc.height;
    const W = panel.geometry.parameters.width, Hh = panel.geometry.parameters.height;
    const target = panel.localToWorld(new THREE.Vector3((u - 0.5) * W, (v - 0.5) * Hh, 0));
    const c = window.__xrDevice.controllers.right; const from = new THREE.Vector3(0.15, 1.3, 0.2);
    c.position.set(from.x, from.y, from.z);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(from, target, new THREE.Vector3(0, 1, 0)));
    c.quaternion.set(q.x, q.y, q.z, q.w);
    return { visible: panel.visible, u, v };
  }, dxPx, dyPx);
  const a0 = await aim(-10, -8);
  ok(`${H} menu panel visible, gizmo on it`, a0.visible && a0.u > 0 && a0.u < 1 && a0.v > 0 && a0.v < 1, JSON.stringify(a0));
  await sleep(300);
  await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 1)); await sleep(250);
  for (let i = 1; i <= 12; i++) { await aim(-10 + i * 4, -8 + i * 2); await sleep(60); }
  await sleep(200);
  await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 0)); await sleep(400);
  const r = await rot(p);
  ok(`${H} controller-ray drag on the gizmo rotates the origin`, Math.abs(r.yaw) > 10, JSON.stringify(r));
  // trigger click on the Reset button
  await p.evaluate(() => gsOrigin.set({ yaw: 40, pitch: 0, roll: 0 }));
  await p.evaluate(() => document.getElementById('dchat-origin-reset').scrollIntoView({ block: 'center' })); await sleep(800);
  await p.evaluate(() => {
    const panel = scene.getObjectByName('htmlInCanvasPanel');
    const dc = document.getElementById('desktop-chat').getBoundingClientRect(); const br = document.getElementById('dchat-origin-reset').getBoundingClientRect();
    const u = (br.left + br.width / 2 - dc.left) / dc.width, v = 1 - (br.top + br.height / 2 - dc.top) / dc.height;
    const target = panel.localToWorld(new THREE.Vector3((u - 0.5) * panel.geometry.parameters.width, (v - 0.5) * panel.geometry.parameters.height, 0));
    const c = window.__xrDevice.controllers.right; const from = new THREE.Vector3(0.15, 1.3, 0.2); c.position.set(from.x, from.y, from.z);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(from, target, new THREE.Vector3(0, 1, 0))); c.quaternion.set(q.x, q.y, q.z, q.w);
  });
  await sleep(300);
  await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 1)); await sleep(200);
  await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 0)); await sleep(500);
  ok(`${H} trigger on Reset origin resets`, (await p.evaluate(() => gsOrigin._gizmo.isIdentity())), JSON.stringify(await rot(p)));
  await p.evaluate(() => gsOrigin.set({ yaw: 35, pitch: 20, roll: 0 })); await sleep(300);
  await p.evaluate(() => document.getElementById('dchat-origin').scrollIntoView({ block: 'center' })); await sleep(1500);
  const vr = await p.evaluate(() => { const m = scene.getObjectByName('box'); const under = (o) => { for (let n = o; n; n = n.parent) if (n === gsOrigin.root) return true; return false; }; const pl = scene.getObjectByName('player'); return { parent: m.parent.name, rig: !!pl && !under(pl) && !under(scene.getObjectByName('htmlInCanvasPanel')) }; });
  ok(`${H} content rotated in VR, player rig not`, vr.parent === 'gsOriginRoot' && vr.rig);
  await p.screenshot({ path: `${SHOT_DIR}/vr-menu-gizmo.png` });
  ok(`${H} no console/page errors`, p._errs.length === 0, JSON.stringify(p._errs.slice(0, 5)));
  await p._ctx.close();
}

await b.close();
const pass = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
