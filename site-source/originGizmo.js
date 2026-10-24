// Origin rotation (Environment tab): rotates the frame the scene's content
// lives in (the `gsOriginRoot` group, see main.js) around the scene origin,
// so the user can line the scene up with the view they want.
//
// The gizmo is a plain 2D <canvas> (no three.js overlay). It draws the
// content's X / Y / Z axes as seen from the current camera, Blender style:
//   - drag inside the ball: trackball (left/right turns about world up,
//     up/down tilts about the camera's right axis);
//   - drag on the outer ring: roll about the view axis;
//   - click an axis end: turn the scene so that axis points at you;
//   - Shift (or the "Snap 15°" toggle) snaps yaw / pitch / roll to 15°.
// Angles are yaw (about Y), pitch (about X), roll (about Z), Euler order YXZ,
// in degrees. The module only needs pointer events, so mouse, touch and the
// VR controller ray (main.js forwards it as pointer events) all work.

const AXES = [
	{ id: 'x', label: 'X', color: '#ff4d64', dim: '#9e3443', v: [1, 0, 0] },
	{ id: 'y', label: 'Y', color: '#8fdc2a', dim: '#5a8a1c', v: [0, 1, 0] },
	{ id: 'z', label: 'Z', color: '#3d9bff', dim: '#2a64a6', v: [0, 0, 1] }
];
export const ORIGIN_SNAP_DEG = 15;
const DRAG_DEG_PER_PX = 0.9;
const CLICK_SLOP_PX = 4;

const wrap180 = (a) => { let x = ((a + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x; };
const clean = (a) => { const r = Math.round(a * 1000) / 1000; return Object.is(r, -0) ? 0 : r; };

/** Normalise any { yaw, pitch, roll } (degrees) value; bad input → zeros. */
export function normalizeOriginRotation(v) {
	const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
	if (!v || typeof v !== 'object') return { yaw: 0, pitch: 0, roll: 0 };
	return { yaw: clean(wrap180(n(v.yaw))), pitch: clean(Math.max(-90, Math.min(90, n(v.pitch)))), roll: clean(wrap180(n(v.roll))) };
}

export function isIdentityOriginRotation(v) {
	const r = normalizeOriginRotation(v);
	return Math.abs(r.yaw) < 1e-6 && Math.abs(r.pitch) < 1e-6 && Math.abs(r.roll) < 1e-6;
}

/**
 * @param {object} o
 * @param {typeof import('three')} o.THREE
 * @param {THREE.Object3D} o.root            group whose rotation is the origin rotation
 * @param {() => THREE.Quaternion} o.getViewQuaternion  world rotation of the viewing camera
 * @param {(rot, why) => void} [o.onChange]  after every change (persist, re-adopt content…)
 * @param {() => void} [o.onRedraw]          the gizmo canvas was repainted (VR mirror refresh)
 */
export function createOriginRotation({ THREE, root, getViewQuaternion, onChange = () => {}, onRedraw = () => {} }) {
	const _e = new THREE.Euler(0, 0, 0, 'YXZ');
	const _q = new THREE.Quaternion();
	const _qa = new THREE.Quaternion();
	const _v = new THREE.Vector3();
	const _v2 = new THREE.Vector3();
	const _invView = new THREE.Quaternion();
	const UP = new THREE.Vector3(0, 1, 0);
	let rot = { yaw: 0, pitch: 0, roll: 0 };
	let snapToggle = false;
	let ui = null;

	const toQuat = (r, out = new THREE.Quaternion()) => out.setFromEuler(_e.set(
		THREE.MathUtils.degToRad(r.pitch), THREE.MathUtils.degToRad(r.yaw), THREE.MathUtils.degToRad(r.roll), 'YXZ'));
	const fromQuat = (q) => {
		_e.setFromQuaternion(q, 'YXZ');
		return normalizeOriginRotation({ yaw: THREE.MathUtils.radToDeg(_e.y), pitch: THREE.MathUtils.radToDeg(_e.x), roll: THREE.MathUtils.radToDeg(_e.z) });
	};
	const snapRot = (r, step = ORIGIN_SNAP_DEG) => normalizeOriginRotation({
		yaw: Math.round(r.yaw / step) * step, pitch: Math.round(r.pitch / step) * step, roll: Math.round(r.roll / step) * step });

	function set(next, why = 'set') {
		rot = normalizeOriginRotation(next);
		toQuat(rot, root.quaternion);
		root.updateMatrixWorld(true);
		syncInputs();
		draw();
		onChange({ ...rot }, why);
		return { ...rot };
	}
	function setQuaternion(q, why, snap) {
		let r = fromQuat(q);
		if (snap) r = snapRot(r);
		return set(r, why);
	}

	// ---- view helpers
	function viewQ() { const q = getViewQuaternion(); return q ? q.clone() : new THREE.Quaternion(); }
	/** Axis (content frame) → view-space direction (x right, y up, z toward the viewer). */
	function axisInView(axisV, sign, out) {
		_invView.copy(viewQ()).invert();
		return out.set(axisV[0] * sign, axisV[1] * sign, axisV[2] * sign).applyQuaternion(root.quaternion).applyQuaternion(_invView);
	}

	/** Turn the scene so the given axis end points at the viewer (snapped to the
	 *  world axis closest to "toward the camera"), then square it up to 90°. */
	function alignAxisToView(axisId, sign = 1) {
		const ax = AXES.find((a) => a.id === axisId);
		if (!ax) return { ...rot };
		const back = _v2.set(0, 0, 1).applyQuaternion(viewQ()); // toward the viewer, world
		const comps = [Math.abs(back.x), Math.abs(back.y), Math.abs(back.z)];
		const i = comps.indexOf(Math.max(...comps));
		const target = new THREE.Vector3(); target.setComponent(i, Math.sign(back.getComponent(i)) || 1);
		const cur = _v.set(ax.v[0] * sign, ax.v[1] * sign, ax.v[2] * sign).applyQuaternion(root.quaternion).normalize();
		_qa.setFromUnitVectors(cur, target);
		_q.copy(_qa).multiply(root.quaternion);
		// Square to 90° steps when that keeps the axis on target (it does unless
		// pitch lands near ±90°, where the Euler split is ambiguous).
		const sq = snapRot(fromQuat(_q), 90);
		const check = _v.set(ax.v[0] * sign, ax.v[1] * sign, ax.v[2] * sign).applyQuaternion(toQuat(sq));
		if (check.distanceTo(target) < 1e-4) return set(sq, 'align');
		return setQuaternion(_q, 'align', false);
	}

	/** Trackball step: dx/dy in CSS px of drag. Applies to `base` (raw, unsnapped). */
	function dragRotate(base, dx, dy) {
		const vq = viewQ();
		const right = _v.set(1, 0, 0).applyQuaternion(vq).normalize();
		const out = base.clone();
		_qa.setFromAxisAngle(UP, THREE.MathUtils.degToRad(dx * DRAG_DEG_PER_PX));
		out.premultiply(_qa);
		_qa.setFromAxisAngle(right, THREE.MathUtils.degToRad(dy * DRAG_DEG_PER_PX));
		out.premultiply(_qa);
		return out;
	}
	function rollRotate(base, dAngleRad) {
		const toward = _v.set(0, 0, 1).applyQuaternion(viewQ()).normalize();
		_qa.setFromAxisAngle(toward, -dAngleRad); // screen clockwise = scene clockwise as seen
		return base.clone().premultiply(_qa);
	}

	// ---- 2D gizmo
	function geometry(canvas) {
		const w = canvas.clientWidth || 180, h = canvas.clientHeight || 180;
		const s = Math.min(w, h);
		return { w, h, cx: w / 2, cy: h / 2, R: s * 0.33, ringIn: s * 0.40, ringOut: s * 0.48, endR: Math.max(9, s * 0.065) };
	}
	function axisEnds(g) {
		const ends = [];
		for (const ax of AXES) {
			for (const sign of [1, -1]) {
				const p = axisInView(ax.v, sign, new THREE.Vector3());
				ends.push({ ax, sign, x: g.cx + p.x * g.R, y: g.cy - p.y * g.R, z: p.z });
			}
		}
		return ends.sort((a, b) => a.z - b.z); // back to front
	}
	let hover = null; // { kind: 'end', id, sign } | { kind: 'ring' } | { kind: 'ball' }
	function hitTest(g, x, y) {
		const ends = axisEnds(g);
		for (let i = ends.length - 1; i >= 0; i--) { // front first
			const e = ends[i];
			if (Math.hypot(x - e.x, y - e.y) <= g.endR + 3) return { kind: 'end', id: e.ax.id, sign: e.sign };
		}
		const r = Math.hypot(x - g.cx, y - g.cy);
		if (r <= g.ringIn - 1) return { kind: 'ball' };
		if (r <= g.ringOut + 4) return { kind: 'ring' };
		return null;
	}
	let _lastViewKey = '';
	function draw() {
		const canvas = ui && ui.canvas;
		if (!canvas) return;
		const dpr = Math.min(3, window.devicePixelRatio || 1);
		const g = geometry(canvas);
		const W = Math.round(g.w * dpr), H = Math.round(g.h * dpr);
		if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
		const ctx = canvas.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, g.w, g.h);
		// ring (roll) with 15° ticks
		ctx.beginPath(); ctx.arc(g.cx, g.cy, (g.ringIn + g.ringOut) / 2, 0, Math.PI * 2);
		ctx.lineWidth = g.ringOut - g.ringIn;
		ctx.strokeStyle = hover && hover.kind === 'ring' || drag && drag.kind === 'ring' ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)';
		ctx.stroke();
		ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
		const rollRad = THREE.MathUtils.degToRad(rot.roll);
		for (let k = 0; k < 24; k++) {
			const a = k * Math.PI / 12 - Math.PI / 2 + rollRad;
			const r0 = k % 6 === 0 ? g.ringIn + 1 : g.ringIn + (g.ringOut - g.ringIn) * 0.45;
			ctx.beginPath(); ctx.moveTo(g.cx + Math.cos(a) * r0, g.cy + Math.sin(a) * r0);
			ctx.lineTo(g.cx + Math.cos(a) * (g.ringOut - 1), g.cy + Math.sin(a) * (g.ringOut - 1)); ctx.stroke();
		}
		// ball
		ctx.beginPath(); ctx.arc(g.cx, g.cy, g.ringIn - 2, 0, Math.PI * 2);
		ctx.fillStyle = hover && hover.kind === 'ball' || drag && drag.kind === 'ball' ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)';
		ctx.fill();
		// axes, back to front
		for (const e of axisEnds(g)) {
			const front = e.sign > 0;
			const hot = hover && hover.kind === 'end' && hover.id === e.ax.id && hover.sign === e.sign;
			if (front) {
				ctx.beginPath(); ctx.moveTo(g.cx, g.cy); ctx.lineTo(e.x, e.y);
				ctx.strokeStyle = e.ax.color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
			}
			ctx.beginPath(); ctx.arc(e.x, e.y, g.endR * (front ? 1 : 0.85), 0, Math.PI * 2);
			ctx.fillStyle = front ? e.ax.color : (hot ? e.ax.dim : 'rgba(20,22,30,0.92)');
			ctx.fill();
			ctx.lineWidth = front ? (hot ? 2.5 : 0) : 2;
			ctx.strokeStyle = front ? '#fff' : e.ax.color;
			if (!front || hot) ctx.stroke();
			ctx.fillStyle = front ? '#0b0d12' : e.ax.color;
			ctx.font = `700 ${Math.round(g.endR * (front ? 1.15 : 0.9))}px system-ui, sans-serif`;
			ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.fillText(front ? e.ax.label : '-' + e.ax.label, e.x, e.y + 0.5);
		}
		onRedraw();
	}

	// ---- pointer handling
	let drag = null; // { pointerId, kind, startX, startY, lastX, lastY, base: Quaternion, moved, end, angle }
	const localXY = (canvas, ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
	function onDown(ev) {
		if (!ui) return;
		if (ev.button !== undefined && ev.button > 0) return;
		const g = geometry(ui.canvas);
		const [x, y] = localXY(ui.canvas, ev);
		const hit = hitTest(g, x, y);
		if (!hit) return;
		ev.preventDefault();
		try { ui.canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic (VR) pointer */ }
		drag = { pointerId: ev.pointerId, kind: hit.kind === 'ring' ? 'ring' : 'ball', end: hit.kind === 'end' ? hit : null,
			startX: x, startY: y, base: root.quaternion.clone(), moved: false, angle: Math.atan2(y - g.cy, x - g.cx) };
		window.addEventListener('pointermove', onMove, true);
		window.addEventListener('pointerup', onUp, true);
		window.addEventListener('pointercancel', onUp, true);
		draw();
	}
	function onMove(ev) {
		if (!ui) return;
		const g = geometry(ui.canvas);
		const [x, y] = localXY(ui.canvas, ev);
		if (!drag) { const h = hitTest(g, x, y); if (JSON.stringify(h) !== JSON.stringify(hover)) { hover = h; draw(); } return; }
		if (ev.pointerId !== drag.pointerId) return;
		ev.preventDefault();
		const dx = x - drag.startX, dy = y - drag.startY;
		if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
		drag.moved = true;
		const snap = ev.shiftKey || snapToggle;
		const q = drag.kind === 'ring'
			? rollRotate(drag.base, Math.atan2(y - g.cy, x - g.cx) - drag.angle)
			: dragRotate(drag.base, dx, dy);
		setQuaternion(q, 'drag', snap);
	}
	function onUp(ev) {
		if (!drag || ev.pointerId !== drag.pointerId) return;
		const d = drag; drag = null;
		window.removeEventListener('pointermove', onMove, true);
		window.removeEventListener('pointerup', onUp, true);
		window.removeEventListener('pointercancel', onUp, true);
		try { ui.canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
		if (!d.moved && d.end && ev.type === 'pointerup') alignAxisToView(d.end.id, d.end.sign);
		else draw();
	}
	function onHover(ev) { if (!drag) onMove(ev); }
	function onLeave() { if (!drag && hover) { hover = null; draw(); } }

	function syncInputs() {
		if (!ui) return;
		for (const k of ['yaw', 'pitch', 'roll']) {
			const el = ui.inputs[k];
			if (el && document.activeElement !== el) el.value = String(Math.round(rot[k] * 10) / 10);
		}
		if (ui.readout) ui.readout.textContent = isIdentityOriginRotation(rot) ? 'Not rotated' : `Yaw ${fmt(rot.yaw)} · Pitch ${fmt(rot.pitch)} · Roll ${fmt(rot.roll)}`;
	}
	const fmt = (a) => `${Math.round(a * 10) / 10}°`;

	/** Wire up the Environment tab markup (see index.html #dchat-origin). */
	function mount(container) {
		const q = (sel) => container.querySelector(sel);
		ui = {
			container,
			canvas: q('#dchat-origin-gizmo'),
			inputs: { yaw: q('#dchat-origin-yaw'), pitch: q('#dchat-origin-pitch'), roll: q('#dchat-origin-roll') },
			snap: q('#dchat-origin-snap'),
			reset: q('#dchat-origin-reset'),
			readout: q('#dchat-origin-readout')
		};
		ui.canvas.addEventListener('pointerdown', onDown);
		ui.canvas.addEventListener('pointermove', onHover);
		ui.canvas.addEventListener('pointerleave', onLeave);
		for (const [k, el] of Object.entries(ui.inputs)) {
			if (!el) continue;
			const apply = () => {
				const v = Number(el.value);
				if (el.value.trim() === '' || !Number.isFinite(v)) { syncInputs(); return; }
				const next = { ...rot, [k]: v };
				set(snapToggle ? snapRot(normalizeOriginRotation(next)) : next, 'input');
			};
			el.addEventListener('change', apply);
			el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { apply(); el.blur(); } });
			el.addEventListener('blur', syncInputs);
		}
		if (ui.snap) ui.snap.addEventListener('change', () => { snapToggle = !!ui.snap.checked; });
		if (ui.reset) ui.reset.addEventListener('click', () => set({ yaw: 0, pitch: 0, roll: 0 }, 'reset'));
		syncInputs();
		draw();
	}

	/** Per frame: repaint when the gizmo is on screen and the view turned.
	 *  `coarse` (VR: every repaint also repaints the mirrored menu) ignores
	 *  head jitter below about a degree. */
	function tick(coarse = false) {
		const c = ui && ui.canvas;
		if (!c || !c.isConnected || c.offsetParent === null) return;
		const vq = getViewQuaternion();
		const d = coarse ? 2 : 4;
		const key = vq ? `${vq.x.toFixed(d)},${vq.y.toFixed(d)},${vq.z.toFixed(d)},${vq.w.toFixed(d)},${c.clientWidth}` : '';
		if (key !== _lastViewKey) { _lastViewKey = key; draw(); }
	}

	return {
		get rotation() { return { ...rot }; },
		get snap() { return snapToggle; },
		set snap(v) { snapToggle = !!v; if (ui && ui.snap) ui.snap.checked = snapToggle; },
		set: (r, why) => set(r, why || 'api'),
		reset: () => set({ yaw: 0, pitch: 0, roll: 0 }, 'reset'),
		alignAxis: (id, sign) => alignAxisToView(id, sign),
		isIdentity: () => isIdentityOriginRotation(rot),
		mount, tick, draw,
		/** Debug/test hook: on-screen (client) position of each axis end. */
		axisEndPoints() {
			if (!ui) return [];
			const r = ui.canvas.getBoundingClientRect();
			return axisEnds(geometry(ui.canvas)).map((e) => ({ id: e.ax.id, sign: e.sign, x: r.left + e.x, y: r.top + e.y, z: e.z }));
		}
	};
}
