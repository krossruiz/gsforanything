// VR window paint cost in an IWER Quest 3 session: the menu window on the
// Code tab with a long script, while the stick scrolls it every frame.
// Repaints must stay throttled (<= ~15/s) and frames must keep flowing.
//   BASE=https://localhost:3711 node perf.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3711';
const IWER = fs.readFileSync(new URL('./node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1280, height: 800 });
await p.evaluateOnNewDocument(IWER + '\n;window.__xrDevice = new IWER.XRDevice(IWER.metaQuest3); window.__xrDevice.installRuntime({ forceInstall: true });');
await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await sleep(1500);
await p.click('#XRButton').catch(() => {});
for (let i = 0; i < 40 && !(await p.evaluate(() => renderer.xr.isPresenting)); i++) await sleep(250);
await sleep(1000);
const r = await p.evaluate(async () => {
	document.querySelector('.dchat-tab[data-tab="code"]').click();
	const ed = document.getElementById('dchat-code-editor');
	ed.value = Array.from({ length: 600 }, (_, i) => `const v${i} = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)); // line ${i}`).join('\n');
	ed.dispatchEvent(new Event('input', { bubbles: true }));
	const w = window.__gsVrWindows.byName('menu');
	const t0 = performance.now(); w.tick(true); const one = performance.now() - t0;
	const paints0 = w.paints; let frames = 0; const s = renderer.xr.getSession();
	const end = performance.now() + 3000;
	await new Promise((res) => { const f = () => { frames++; ed.scrollTop += 4; if (performance.now() < end) s.requestAnimationFrame(f); else res(); }; s.requestAnimationFrame(f); });
	return { onePaintMs: +one.toFixed(1), paintsPerSec: +((w.paints - paints0) / 3).toFixed(1), framesPerSec: +(frames / 3).toFixed(1) };
});
console.log(JSON.stringify(r));
const ok = r.paintsPerSec <= 16 && r.framesPerSec > 5;
console.log(`${ok ? 'PASS' : 'FAIL'} menu repaint throttled while scrolling the Code tab (${r.paintsPerSec}/s, one paint ${r.onePaintMs} ms, ${r.framesPerSec} XR frames/s under SwiftShader)`);
await b.close(); process.exit(ok ? 0 : 1);
