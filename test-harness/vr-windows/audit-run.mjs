// Prints the contrast audit for one build. BASE=... OPAQUE=1 node audit-run.mjs
import puppeteer from 'puppeteer-core'; import fs from 'fs';
const BASE = process.env.BASE || 'https://localhost:3711';
const AUDIT = fs.readFileSync(new URL('./contrast-audit.js', import.meta.url), 'utf8');
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--ignore-certificate-errors', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1280, height: 800 });
await p.goto(BASE + '/', { waitUntil: 'networkidle2' }); await new Promise(r => setTimeout(r, 2000));
await p.evaluate(AUDIT);
await p.evaluate(() => { const m = document.getElementById('desktop-chat-messages'); const u = document.createElement('div'); u.className = 'dchat-msg user'; u.textContent = 'hi'; m.appendChild(u); });
const res = await p.evaluate((o) => window.__gsContrastAudit({ backdrop: '#1a1d23', opaqueRoot: o }), !!process.env.OPAQUE);
for (const r of res) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name.padEnd(36)} ${String(r.ratio).padStart(6)}:1 (need ${r.target}) ${r.fg || ''} on ${r.bg || ''}`);
if (process.env.JSON) fs.writeFileSync(process.env.JSON, JSON.stringify(res, null, 1));
await b.close();
