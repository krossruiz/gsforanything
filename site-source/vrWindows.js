/**
 * VR windows: the one way GS shows UI inside an immersive session.
 *
 * Each window is a live DOM element (laid out off-screen by the browser,
 * styled by the same CSS as the desktop menu) painted into a canvas texture
 * by htmlInCanvas.js and shown on a flat mesh. The controller ray is mapped
 * back onto that element, so point, hover, click, drag-scroll, thumbstick
 * scroll and text-field targeting behave the same on every window. Text
 * fields are never DOM-focused in XR (that summons the Quest system keyboard,
 * which crashes the session); onTextFieldFocus hands them to the in-scene
 * VR keyboard instead.
 *
 * Consistency rules every window follows:
 *  - Same pixel-to-metre scale (VR_PX_TO_M at the window distance; a
 *    head-locked window is scaled by its distance so text has the same
 *    angular size everywhere).
 *  - Same frame: the element's own rounded, opaque panel background.
 *  - Same hover ring (.gs-ray-hover on the actionable element under the ray)
 *    and the same focus ring (:focus-visible), both from index.html.
 *  - Repaints are dirty-driven (MutationObserver + scroll/input/focus), capped
 *    at ~15/s, with a slow idle refresh. Nothing repaints every frame.
 */

export const VR_WINDOW_DISTANCE = 1.5;           // metres, world windows
export const VR_PX_TO_M = 1.12 / 640;            // 640 CSS px wide -> 1.12 m at 1.5 m
export const HTML_PAINT_MIN_MS = 66;             // cap repaints at ~15/s while content changes
export const HTML_PAINT_IDLE_MS = 2000;          // safety refresh for CSS-only changes
const SCROLL_DRAG_PX = 8;
const HOVER_MIN_MS = 50;
const ACTIONABLE = 'button, a, label, select, input, textarea, summary, [data-action], [role="button"], [role="radio"], [role="tab"], .menu-btn';
const SOURCE_CLASS = 'html-in-canvas-source';

export function isHtmlTextField(el) {
	if (!el) return false;
	if (el instanceof HTMLTextAreaElement) return !el.readOnly;
	if (el instanceof HTMLInputElement) {
		const skip = ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'image', 'hidden'];
		return !skip.includes(el.type) && !el.readOnly;
	}
	return false;
}

/**
 * @param {object} deps
 * @param {typeof import('three')} deps.THREE
 * @param {(el: Element, canvas: HTMLCanvasElement, opts?: object) => {width:number,height:number}} deps.paint
 * @param {(field: HTMLElement, win: object) => void} [deps.onTextFieldFocus]
 * @param {(win: object, el: Element, field: Element|null) => void} [deps.onActivate]  after any forwarded click
 */
export function createVrWindowManager({ THREE, paint, onTextFieldFocus, onActivate }) {
	const windows = [];

	function createWindow({
		name,
		source,
		parent,
		distance = VR_WINDOW_DISTANCE,
		pixelScale = 1.5,
		maxSize = 1400,
		renderOrder = 0,
		depthTest = true,
		blocked = () => false
	}) {
		const canvas = document.createElement('canvas');
		canvas.width = 4;
		canvas.height = 4;
		const texture = new THREE.CanvasTexture(canvas);
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;
		texture.colorSpace = THREE.SRGBColorSpace;
		const material = new THREE.MeshBasicMaterial({
			map: texture,
			transparent: true,
			side: THREE.DoubleSide,
			depthTest,
			depthWrite: depthTest,
			// Exact CSS colours: no tone mapping on UI (it lifted the darks and
			// cut the contrast of the old panels).
			toneMapped: false
		});
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
		mesh.name = 'vrWindow:' + name;
		mesh.visible = false;
		mesh.renderOrder = renderOrder;
		mesh.userData.vrWindow = name;
		if (parent) parent.add(mesh);

		const win = {
			name,
			source,
			mesh,
			canvas,
			texture,
			distance,
			pixelScale,
			maxSize,
			blocked,
			widthM: 0,
			heightM: 0,
			paints: 0,
			_dirty: true,
			_paintAt: -Infinity,
			_observer: null,
			_hover: [null, null],
			_hoverAt: [0, 0],
			_hoverUv: [null, null],
			drag: [null, null],
			get visible() { return mesh.visible; }
		};
		const markDirty = () => { win._dirty = true; };
		win.markDirty = markDirty;
		const EVENTS = ['scroll', 'input', 'change', 'focusin', 'focusout'];

		win.setVisible = (on) => {
			on = !!on;
			source.classList.toggle(SOURCE_CLASS, on);
			if (on && !win._observer) {
				win._observer = new MutationObserver(markDirty);
				win._observer.observe(source, { subtree: true, childList: true, characterData: true, attributes: true });
				for (const ev of EVENTS) source.addEventListener(ev, markDirty, true);
			} else if (!on && win._observer) {
				win._observer.disconnect();
				win._observer = null;
				for (const ev of EVENTS) source.removeEventListener(ev, markDirty, true);
				for (let i = 0; i < 2; i++) win.setHover(i, null);
				win.drag[0] = win.drag[1] = null;
			}
			const was = mesh.visible;
			mesh.visible = on;
			if (on && !was) win.tick(true);
		};

		// Same CSS px -> metre scale for every window; head-locked windows are
		// scaled by distance so they read at the same angular size.
		win.layout = (cssW, cssH) => {
			const k = VR_PX_TO_M * (win.distance / VR_WINDOW_DISTANCE);
			const w = Math.max(0.01, cssW * k);
			const h = Math.max(0.01, cssH * k);
			if (Math.abs(w - win.widthM) > 0.0005 || Math.abs(h - win.heightM) > 0.0005) {
				win.widthM = w;
				win.heightM = h;
				mesh.scale.set(w, h, 1);
				if (win.onResize) win.onResize(w, h);
			}
		};

		win.tick = (force = false, now = performance.now()) => {
			if (!mesh.visible) return false;
			if (!force) {
				const since = now - win._paintAt;
				if (win._dirty ? since < HTML_PAINT_MIN_MS : since < HTML_PAINT_IDLE_MS) return false;
			}
			win._paintAt = now;
			win._dirty = false;
			try {
				const m = paint(source, canvas, { pixelScale: win.pixelScale, maxSize: win.maxSize, opaque: true });
				texture.needsUpdate = true;
				win.paints++;
				if (m && m.width > 0) win.layout(m.width, m.height);
			} catch (err) {
				console.warn(`VR window "${name}" paint failed:`, err);
			}
			return true;
		};

		win.pointFromUV = (uv) => {
			if (!uv) return null;
			const rect = source.getBoundingClientRect();
			if (rect.width < 2 || rect.height < 2) return null;
			return {
				x: rect.left + uv.x * rect.width,
				y: rect.top + (1 - uv.y) * rect.height,
				localX: uv.x * rect.width,
				localY: (1 - uv.y) * rect.height
			};
		};

		// Smallest visible box under the point (later nodes win ties). Checks
		// the cheap box first, reads computed style only for boxes containing
		// the point, and skips the inside of clipping boxes the point is not in.
		win.elementAt = (x, y) => {
			let best = null;
			let bestArea = Infinity;
			const visit = (el) => {
				for (const child of el.children) {
					const r = child.getBoundingClientRect();
					const inside = r.width > 0 && r.height > 0 && x >= r.left && y >= r.top && x <= r.right && y <= r.bottom;
					let style = null;
					if (inside) {
						style = getComputedStyle(child);
						if (style.display !== 'none' && style.visibility !== 'hidden') {
							const area = r.width * r.height;
							if (area <= bestArea) {
								best = child;
								bestArea = area;
							}
						}
					}
					if (child.children.length === 0) continue;
					if (!inside && r.width > 0 && r.height > 0) {
						style = style || getComputedStyle(child);
						if (style.overflowX !== 'visible' && style.overflowY !== 'visible') continue;
					}
					visit(child);
				}
			};
			visit(source);
			return best;
		};

		win.elementAtUV = (uv) => {
			const p = win.pointFromUV(uv);
			return p ? win.elementAt(p.x, p.y) : null;
		};

		win.scrollableAt = (el) => {
			for (let node = el; node && source.contains(node); node = node.parentElement) {
				const style = getComputedStyle(node);
				const oy = style.overflowY;
				const ox = style.overflowX;
				const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight + 1;
				const canX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && node.scrollWidth > node.clientWidth + 1;
				if (canY || canX) return { el: node, canX, canY };
				if (node === source) break;
			}
			return null;
		};

		win.actionableAt = (el) => {
			if (!el || blocked(el)) return null;
			const a = el.closest(ACTIONABLE);
			return a && source.contains(a) ? a : null;
		};

		// Ray hover: one .gs-ray-hover element per hand, recomputed at most every
		// HOVER_MIN_MS and only when the ray moved on the window.
		win.setHover = (hand, uv, now = performance.now()) => {
			let target = null;
			if (uv) {
				const last = win._hoverUv[hand];
				const moved = !last || Math.abs(last.x - uv.x) * source.clientWidth > 2 || Math.abs(last.y - uv.y) * source.clientHeight > 2;
				if (!moved || now - win._hoverAt[hand] < HOVER_MIN_MS) return win._hover[hand];
				win._hoverAt[hand] = now;
				win._hoverUv[hand] = { x: uv.x, y: uv.y };
				target = win.actionableAt(win.elementAtUV(uv));
			} else {
				win._hoverUv[hand] = null;
			}
			const prev = win._hover[hand];
			if (prev === target) return target;
			win._hover[hand] = target;
			if (prev && prev !== win._hover[1 - hand]) prev.classList.remove('gs-ray-hover');
			if (target) target.classList.add('gs-ray-hover');
			return target;
		};

		win.click = (uv) => {
			const p = win.pointFromUV(uv);
			if (!p) return null;
			const el = win.elementAt(p.x, p.y);
			if (!el || blocked(el)) return null;
			const label = el.closest('label');
			let field = el.closest('input, textarea, select');
			if (!field && label) field = label.control || label.querySelector('input, textarea, select');
			if (field && !source.contains(field)) field = null;
			if (field && field.disabled) return null;
			if (field instanceof HTMLSelectElement && field.options.length > 0) {
				field.selectedIndex = (field.selectedIndex + 1) % field.options.length;
				field.dispatchEvent(new Event('input', { bubbles: true }));
				field.dispatchEvent(new Event('change', { bubbles: true }));
			} else if (field instanceof HTMLInputElement && field.type === 'range') {
				const r = field.getBoundingClientRect();
				const t = r.width > 0 ? Math.min(1, Math.max(0, (p.x - r.left) / r.width)) : 0;
				const min = Number(field.min || 0);
				const max = Number(field.max || 100);
				field.value = String(min + t * (max - min));
				field.dispatchEvent(new Event('input', { bubbles: true }));
				field.dispatchEvent(new Event('change', { bubbles: true }));
			} else if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
				if (field.type === 'radio') field.checked = true;
				else field.checked = !field.checked;
				field.dispatchEvent(new Event('input', { bubbles: true }));
				field.dispatchEvent(new Event('change', { bubbles: true }));
			} else if (isHtmlTextField(field)) {
				if (onTextFieldFocus) onTextFieldFocus(field, win);
			} else {
				const actionEl = el.closest(ACTIONABLE) || el;
				if (actionEl.disabled) return null;
				// SVG menu buttons (menuSystem.js) listen on the <g>/<svg>; a click
				// event at the real point reaches them like a mouse click.
				actionEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y }));
			}
			if (onActivate) onActivate(win, el, field);
			win.tick(true);
			return field || el;
		};

		// Trigger on a scroller starts a drag; a press that doesn't move clicks
		// on release. Returns false when the point isn't scrollable.
		win.beginDrag = (hand, uv) => {
			const p = win.pointFromUV(uv);
			if (!p) return false;
			const el = win.elementAt(p.x, p.y);
			if (!el || blocked(el)) return false;
			const scroll = win.scrollableAt(el);
			if (!scroll) return false;
			win.drag[hand] = {
				uv: { x: uv.x, y: uv.y },
				scroller: scroll.el,
				canX: scroll.canX,
				canY: scroll.canY,
				startX: p.localX,
				startY: p.localY,
				originLeft: scroll.el.scrollLeft,
				originTop: scroll.el.scrollTop,
				moved: false
			};
			return true;
		};

		win.moveDrag = (hand, uv) => {
			const d = win.drag[hand];
			if (!d || !d.scroller.isConnected) { win.drag[hand] = null; return; }
			const p = win.pointFromUV(uv);
			if (!p) return;
			const dx = p.localX - d.startX;
			const dy = p.localY - d.startY;
			if (!d.moved && (Math.abs(dx) > SCROLL_DRAG_PX || Math.abs(dy) > SCROLL_DRAG_PX)) d.moved = true;
			if (!d.moved) return;
			if (d.canY) d.scroller.scrollTop = d.originTop - dy;
			if (d.canX) d.scroller.scrollLeft = d.originLeft - dx;
			markDirty();
		};

		win.endDrag = (hand) => {
			const d = win.drag[hand];
			if (!d) return;
			win.drag[hand] = null;
			if (!d.moved) win.click(d.uv);
			else win.tick(true);
		};

		// Thumbstick scroll of whatever scrolls under the ray.
		win.scrollAt = (uv, dy) => {
			const el = win.elementAtUV(uv);
			const scroll = el && win.scrollableAt(el);
			if (!scroll || !scroll.canY) return false;
			const before = scroll.el.scrollTop;
			scroll.el.scrollTop = before + dy;
			if (scroll.el.scrollTop !== before) markDirty();
			return scroll.el.scrollTop !== before;
		};

		windows.push(win);
		return win;
	}

	return {
		windows,
		createWindow,
		byMesh(mesh) { return windows.find((w) => w.mesh === mesh) || null; },
		byName(name) { return windows.find((w) => w.name === name) || null; },
		tickAll(now = performance.now()) { for (const w of windows) w.tick(false, now); },
		anyDragging() { return windows.some((w) => w.drag[0] || w.drag[1]); }
	};
}
