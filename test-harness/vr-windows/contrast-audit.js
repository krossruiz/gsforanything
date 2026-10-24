// WCAG 2.x contrast audit of the GS window UI, evaluated in the page.
// window.__gsContrastAudit({ backdrop: '#1a1d23', opaqueRoot: true }) -> [{ name, kind, ratio, target, pass, fg, bg }]
// Text pairs must reach 4.5:1, UI boundaries (buttons, tabs, fields, hover ring) 3:1.
(() => {
	const parse = (c) => {
		if (!c) return null;
		const m = String(c).match(/rgba?\(([^)]+)\)/);
		if (m) {
			const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
			return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
		}
		if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
			let h = c.slice(1); if (h.length === 3) h = h.split('').map((x) => x + x).join('');
			return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
		}
		if (c === 'transparent') return [0, 0, 0, 0];
		// Named / other: let the browser resolve it.
		const probe = document.createElement('i'); probe.style.color = c; document.body.appendChild(probe);
		const r = getComputedStyle(probe).color; probe.remove();
		return r && r !== c ? parse(r) : null;
	};
	const over = (top, bottom) => {
		const a = top[3];
		return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
	};
	const lum = (c) => {
		const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
		return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
	};
	const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
	const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
	const gradStops = (img) => (String(img).match(/rgba?\([^)]+\)|#[0-9a-f]{3,6}\b/gi) || []).map(parse).filter(Boolean);

	// Every background layer an element can show: its colour, or each gradient stop.
	function layers(el) {
		const s = getComputedStyle(el);
		const out = [];
		if (el instanceof SVGElement) {
			const fill = el.getAttribute('fill') || s.fill;
			const m = fill && String(fill).match(/url\(#([^)]+)\)/);
			if (m) {
				const g = el.ownerSVGElement && el.ownerSVGElement.querySelector('#' + CSS.escape(m[1]));
				if (g) g.querySelectorAll('stop').forEach((st) => out.push(parse(st.getAttribute('stop-color'))));
			} else if (fill && fill !== 'none') out.push(parse(fill));
			return out.filter(Boolean);
		}
		const stops = s.backgroundImage && s.backgroundImage !== 'none' ? gradStops(s.backgroundImage) : [];
		if (stops.length) return stops;
		const bg = parse(s.backgroundColor);
		if (bg && bg[3] > 0) out.push(bg);
		return out;
	}
	// Opaque colours behind an element (inclusive), composited from the root down.
	function effectiveBgs(el, root, opts, inclusive = true) {
		const chain = [];
		for (let n = inclusive ? el : el.parentElement; n; n = n.parentElement) { chain.unshift(n); if (n === root) break; }
		let cands = [parse(opts.backdrop || '#1a1d23')];
		for (const n of chain) {
			let ls = layers(n);
			if (n === root && opts.opaqueRoot) ls = ls.map((c) => [c[0], c[1], c[2], 1]);
			if (!ls.length) continue;
			const next = [];
			for (const base of cands) for (const l of ls) next.push(over(l, base));
			cands = next;
		}
		return cands;
	}
	function svgRectFor(textEl) { return textEl.parentNode && textEl.parentNode.querySelector('rect'); }

	window.__gsContrastAudit = function (opts = {}) {
		const results = [];
		const add = (name, kind, fgc, bgs, target, extra = {}) => {
			if (!fgc || !bgs || !bgs.length) { results.push({ name, kind, ratio: 0, target, pass: false, missing: true }); return; }
			let worst = Infinity, worstBg = null;
			for (const bg of bgs) { const fg = fgc[3] < 1 ? over(fgc, bg) : fgc; const r = ratio(fg, bg); if (r < worst) { worst = r; worstBg = bg; } }
			results.push({ name, kind, ratio: +worst.toFixed(2), target, pass: worst >= target, fg: hex(fgc[3] < 1 ? over(fgc, worstBg) : fgc), bg: hex(worstBg), ...extra });
		};
		const root = opts.root || document.getElementById('desktop-chat');
		const q = (sel, r = root) => r && r.querySelector(sel);
		const text = (name, el, prop = 'color', rootEl = root) => {
			if (!el) return add(name, 'text', null, null, 4.5);
			const s = getComputedStyle(el);
			add(name, 'text', parse(s[prop]), effectiveBgs(el, rootEl, opts), 4.5);
		};
		const placeholder = (name, el, rootEl = root) => {
			if (!el) return add(name, 'text', null, null, 4.5);
			add(name, 'text', parse(getComputedStyle(el, '::placeholder').color), effectiveBgs(el, rootEl, opts), 4.5);
		};
		// Boundary: the better of the element's border or its fill against what is behind it.
		const boundary = (name, el, rootEl = root) => {
			if (!el) return add(name, 'boundary', null, null, 3);
			const s = getComputedStyle(el);
			const behind = effectiveBgs(el, rootEl, opts, false);
			let best = 0, bestFg = null;
			const tryColor = (c) => { if (!c || c[3] === 0) return; let w = Infinity; for (const b of behind) w = Math.min(w, ratio(c[3] < 1 ? over(c, b) : c, b)); if (w > best) { best = w; bestFg = c; } };
			const bw = parseFloat(s.borderTopWidth) || 0;
			if (bw >= 1 && s.borderTopStyle !== 'none') tryColor(parse(s.borderTopColor));
			const ow = parseFloat(s.outlineWidth) || 0;
			if (ow >= 1 && s.outlineStyle !== 'none') tryColor(parse(s.outlineColor));
			if (el instanceof SVGElement) { const st = el.getAttribute('stroke'); if (st && st !== 'none') tryColor(parse(st)); }
			// A fill only separates the shape if every gradient stop does.
			const ls = layers(el);
			if (ls.length) { let w = Infinity; for (const l of ls) for (const b of behind) w = Math.min(w, ratio(l[3] < 1 ? over(l, b) : l, b)); if (w > best) { best = w; bestFg = ls[0]; } }
			results.push({ name, kind: 'boundary', ratio: +best.toFixed(2), target: 3, pass: best >= 3, fg: bestFg ? hex(bestFg) : null, bg: hex(behind[0]) });
		};
		const svgButton = (name, mount) => {
			const t = mount && mount.querySelector('text');
			const rect = t && svgRectFor(t);
			if (!t || !rect) return add(name, 'text', null, null, 4.5);
			const behind = effectiveBgs(mount, root, opts);
			const fills = layers(rect).flatMap((l) => behind.map((b) => over(l, b)));
			add(name + ' label', 'text', parse(t.getAttribute('fill')), fills, 4.5);
			// boundary of the rect against the panel
			const ls = layers(rect); let best = 0;
			const st = parse(rect.getAttribute('stroke'));
			const cands = [];
			if (st && rect.getAttribute('stroke') !== 'none') cands.push([st]);
			cands.push(ls);
			for (const set of cands) { let w = Infinity; for (const l of set) for (const b of behind) w = Math.min(w, ratio(l[3] < 1 ? over(l, b) : l, b)); best = Math.max(best, w); }
			results.push({ name: name + ' boundary', kind: 'boundary', ratio: +best.toFixed(2), target: 3, pass: best >= 3 });
		};
		const byVariant = (v) => { const g = root.querySelector(`.menu-btn[data-id] rect`); return g; };

		// --- panel text ---
		text('Header title', q('#desktop-chat-header span, #desktop-chat-header .dchat-title, #desktop-chat-header'));
		const assistant = q('.dchat-msg.assistant'); text('Assistant message', assistant);
		const user = q('.dchat-msg.user'); if (user) text('User message', user);
		text('Section label', q('.dchat-section-label'));
		text('Controls help text', q('.dchat-controls-help'));
		// --- tabs ---
		const tabs = [...root.querySelectorAll('.dchat-tab')];
		const inactiveTab = tabs.find((t) => !t.classList.contains('active'));
		const activeTab = tabs.find((t) => t.classList.contains('active'));
		text('Tab (unselected)', inactiveTab); boundary('Tab (unselected) boundary', inactiveTab);
		text('Tab (selected)', activeTab);
		if (activeTab && inactiveTab) {
			// Selected state must not rely on fill alone (WCAG 1.4.11 / 1.4.1):
			// the selected tab's outline has to differ from the unselected
			// tab's outline by >= 3:1 (and stand out on the panel). The fill
			// difference is reported for information only.
			const sa = getComputedStyle(activeTab), si = getComputedStyle(inactiveTab);
			const ba = parseFloat(sa.borderTopWidth) >= 1 && sa.borderTopStyle !== 'none' ? parse(sa.borderTopColor) : null;
			const bi = parseFloat(si.borderTopWidth) >= 1 && si.borderTopStyle !== 'none' ? parse(si.borderTopColor) : null;
			const behind = effectiveBgs(activeTab, root, opts, false)[0];
			const ca = ba ? (ba[3] < 1 ? over(ba, behind) : ba) : behind;
			const ci = bi ? (bi[3] < 1 ? over(bi, behind) : bi) : behind;
			const r = ratio(ca, ci);
			results.push({ name: 'Selected tab indicator (outline vs unselected)', kind: 'state', ratio: +r.toFixed(2), target: 3, pass: r >= 3, fg: hex(ca), bg: hex(ci) });
			const fa = effectiveBgs(activeTab, root, opts)[0], fi = effectiveBgs(inactiveTab, root, opts)[0];
			results.push({ name: 'Selected vs unselected tab fill (info)', kind: 'info', ratio: +ratio(fa, fi).toFixed(2), target: 0, pass: true, fg: hex(fa), bg: hex(fi) });
		}
		const subInactive = q('.dchat-subtab:not(.active)'); const subActive = q('.dchat-subtab.active');
		text('Sub-tab (unselected)', subInactive); boundary('Sub-tab (unselected) boundary', subInactive); text('Sub-tab (selected)', subActive);
		// --- buttons ---
		const btn = q('.dchat-btn.secondary') || q('.dchat-btn'); text('Button text', btn); boundary('Button boundary', btn);
		text('Send button', q('#desktop-send-button')); boundary('Send button boundary', q('#desktop-send-button'));
		const hdrBtn = q('#desktop-chat-header-buttons button'); text('Header button', hdrBtn); boundary('Header button boundary', hdrBtn);
		const accentBtn = q('.dchat-btn.accent'); if (accentBtn) text('Accent button', accentBtn);
		const segActive = q('#dchat-camera-mode .dchat-btn.active'); text('Selected option (camera mode)', segActive);
		const segIdle = q('#dchat-camera-mode .dchat-btn:not(.active)'); text('Unselected option (camera mode)', segIdle); boundary('Unselected option boundary', segIdle);
		// --- fields ---
		const input = q('#desktop-chat-input'); text('Chat input text', input); placeholder('Chat input placeholder', input); boundary('Chat input boundary', input);
		const code = q('#dchat-code-editor'); if (code) placeholder('Code editor placeholder', code);
		const sel = q('#dchat-nav-type'); if (sel) { text('Select text', sel); boundary('Select boundary', sel); }
		// --- shared SVG menu buttons (menuSystem.js) ---
		svgButton('Menu button (Scenes)', q('#dchat-scenes-buttons') || q('[id$="-buttons"] svg')?.parentElement);
		const envMount = q('#dchat-env-mode'); if (envMount) svgButton('Menu toggle (Environment)', envMount);
		// --- ray hover / focus ring ---
		if (opts.hoverProbe !== false) {
			const target = btn || input;
			if (target) {
				target.classList.add('gs-ray-hover');
				boundary('Ray hover ring', target);
				const s = getComputedStyle(target);
				results[results.length - 1].hoverRing = (parseFloat(s.outlineWidth) || 0) >= 2 && s.outlineStyle !== 'none';
				if (!results[results.length - 1].hoverRing) { results[results.length - 1].pass = false; results[results.length - 1].ratio = 0; }
				target.classList.remove('gs-ray-hover');
			}
		}
		// --- other VR windows (keyboard, HUD) when present ---
		const kb = document.getElementById('gs-vr-keyboard');
		if (kb) {
			const key = kb.querySelector('.gs-vr-key:not(.gs-vr-key-action)'); const act = kb.querySelector('.gs-vr-key-action');
			const o2 = { ...opts }; const kbText = (n, el) => { if (!el) return add(n, 'text', null, null, 4.5); add(n, 'text', parse(getComputedStyle(el).color), effectiveBgs(el, kb, o2), 4.5); };
			kbText('Keyboard key', key); kbText('Keyboard action key', act);
			boundary('Keyboard key boundary', key, kb);
		}
		const hud = document.getElementById('gs-vr-hud-toggle');
		if (hud) { add('HUD Hide/Show UI', 'text', parse(getComputedStyle(hud).color), effectiveBgs(hud, hud.parentElement, opts), 4.5); boundary('HUD button boundary', hud, hud.parentElement); }
		return results;
	};
})();
