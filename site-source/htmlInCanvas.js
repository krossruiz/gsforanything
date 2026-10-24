/**
 * Paint a live DOM element into a canvas.
 *
 * Three's CSS3DRenderer (vendor_modules/.../CSS3DRenderer.js) only sets CSS
 * transforms on HTML nodes that sit on top of the page. An immersive WebXR
 * session composites the WebGL framebuffer (plus the flat `dom-overlay`
 * root), not those CSS layers, so a CSS3DObject of #desktop-chat never
 * shows up in the headset. html2canvas is not a dependency.
 *
 * Chrome also refuses to draw SVG <foreignObject> HTML into a canvas image
 * (the snapshot stays blank). This walker instead samples the element the
 * browser has already laid out — the same node, not a second menu — and
 * redraws backgrounds, borders, text, form values, and simple SVG fills.
 * It is a snapshot of that element, refreshed while the toggle is on.
 */

function isTransparent(color) {
	if (!color) return true;
	const c = String(color).replace(/\s+/g, '');
	return c === 'transparent' || c === 'rgba(0,0,0,0)' || c === 'rgba(0,0,0,0.0)';
}

function clipsOverflow(value) {
	return value === 'hidden' || value === 'auto' || value === 'scroll' || value === 'clip';
}

function traceRoundRect(ctx, x, y, w, h, r) {
	const radius = Math.max(0, Math.min(r || 0, w / 2, h / 2));
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.arcTo(x + w, y, x + w, y + h, radius);
	ctx.arcTo(x + w, y + h, x, y + h, radius);
	ctx.arcTo(x, y + h, x, y, radius);
	ctx.arcTo(x, y, x + w, y, radius);
	ctx.closePath();
}

function svgRadiusPx(el) {
	const rx = parseFloat(el.getAttribute && el.getAttribute('rx')) || 0;
	if (!rx) return 0;
	const svg = el.ownerSVGElement;
	if (!svg || !svg.viewBox || !svg.viewBox.baseVal || svg.viewBox.baseVal.width <= 0) return rx;
	const box = svg.getBoundingClientRect();
	if (box.width <= 0) return rx;
	return rx * (box.width / svg.viewBox.baseVal.width);
}

function paintSvgUrlFill(ctx, el, fill, x, y, w, h) {
	const match = String(fill).match(/url\(\s*["']?#([^"')]+)["']?\s*\)/);
	if (!match) return false;
	const svg = el.ownerSVGElement;
	const grad = svg ? svg.querySelector('#' + CSS.escape(match[1])) : null;
	if (!grad || grad.tagName.toLowerCase() !== 'lineargradient') return false;
	const g = ctx.createLinearGradient(x, y, x + w, y + h);
	const stops = grad.querySelectorAll('stop');
	if (!stops.length) return false;
	stops.forEach((stop, i) => {
		let offset = parseFloat(stop.getAttribute('offset'));
		if (!Number.isFinite(offset)) offset = stops.length === 1 ? 0 : i / (stops.length - 1);
		if (offset > 1) offset = offset / 100;
		offset = Math.max(0, Math.min(1, offset));
		const color = stop.getAttribute('stop-color') || '#ffffff';
		const opacity = stop.getAttribute('stop-opacity');
		g.addColorStop(offset, opacity != null && opacity !== '' ? color : color);
	});
	ctx.fillStyle = g;
	return true;
}

function fillBox(ctx, x, y, w, h, radius, style) {
	traceRoundRect(ctx, x, y, w, h, radius);
	ctx.fillStyle = style;
	ctx.fill();
}

function drawBackground(ctx, el, style, ox, oy) {
	const rect = el.getBoundingClientRect();
	const w = rect.width;
	const h = rect.height;
	if (w < 0.5 || h < 0.5) return;
	const x = rect.left - ox;
	const y = rect.top - oy;
	const tag = el.tagName.toLowerCase();
	let radius = 0;
	if (tag === 'rect') radius = svgRadiusPx(el);
	else radius = Math.min(
		parseFloat(style.borderTopLeftRadius) || 0,
		w / 2,
		h / 2
	);

	if (tag === 'rect' || tag === 'path') {
		const fill = style.fill && style.fill !== 'none' ? style.fill : '';
		if (fill && !isTransparent(fill)) {
			if (fill.startsWith('url') && paintSvgUrlFill(ctx, el, fill, x, y, w, h)) {
				traceRoundRect(ctx, x, y, w, h, radius);
				ctx.fill();
			} else if (!fill.startsWith('url')) {
				fillBox(ctx, x, y, w, h, radius, fill);
			}
		}
	} else if (!isTransparent(style.backgroundColor)) {
		fillBox(ctx, x, y, w, h, radius, style.backgroundColor);
	}

	const bw = parseFloat(style.borderTopWidth) || 0;
	if (tag !== 'rect' && bw > 0 && style.borderTopStyle !== 'none' && !isTransparent(style.borderTopColor)) {
		ctx.beginPath();
		traceRoundRect(ctx, x + bw / 2, y + bw / 2, Math.max(0, w - bw), Math.max(0, h - bw), Math.max(0, radius - bw / 2));
		ctx.strokeStyle = style.borderTopColor;
		ctx.lineWidth = bw;
		ctx.stroke();
	}
}

// One Range reused for every text node (was one allocation per node per paint).
let sharedRange = null;

function rectOutside(r, clip) {
	return r.right < clip.left || r.left > clip.right || r.bottom < clip.top || r.top > clip.bottom;
}

function drawTextNode(ctx, node, style, ox, oy, clip) {
	const raw = node.textContent;
	if (!raw || !raw.trim()) return;
	if (!sharedRange) sharedRange = document.createRange();
	const range = sharedRange;
	range.selectNodeContents(node);
	// Skip text scrolled out of the visible area before doing any font work.
	if (clip && rectOutside(range.getBoundingClientRect(), clip)) return;
	ctx.font = style.font || `${style.fontSize} ${style.fontFamily}`;
	const fill = style.fill && style.fill !== 'none' && !String(style.fill).startsWith('url')
		? style.fill
		: style.color;
	ctx.fillStyle = fill || style.color || '#fff';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'top';
	const rects = Array.from(range.getClientRects());
	if (!rects.length) return;
	if (rects.length === 1) {
		// white-space: pre (the Code tab): keep the spaces, the rect starts at
		// the first one. Otherwise collapse like the browser does.
		const pre = String(style.whiteSpace || '').startsWith('pre');
		const text = pre ? raw.replace(/\t/g, '  ').replace(/\n/g, '') : raw.replace(/\s+/g, ' ').trim();
		ctx.fillText(text, rects[0].left - ox, rects[0].top - oy);
		return;
	}
	const words = raw.split(/\s+/).filter(Boolean);
	let index = 0;
	for (const r of rects) {
		if (r.width < 1 || r.height < 1) continue;
		let line = '';
		while (index < words.length) {
			const trial = line ? `${line} ${words[index]}` : words[index];
			if (line && ctx.measureText(trial).width > r.width + 2) break;
			line = trial;
			index++;
		}
		if (line) ctx.fillText(line, r.left - ox, r.top - oy);
	}
}

function drawDirectText(ctx, el, style, ox, oy, clip) {
	for (const node of el.childNodes) {
		if (node.nodeType === Node.TEXT_NODE) drawTextNode(ctx, node, style, ox, oy, clip);
	}
}

function drawFormValue(ctx, el, style, ox, oy) {
	const rect = el.getBoundingClientRect();
	if (rect.width < 2 || rect.height < 2) return;
	const x = rect.left - ox;
	const y = rect.top - oy;
	ctx.font = style.font || `${style.fontSize} ${style.fontFamily}`;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	const midY = y + rect.height / 2;
	const padL = parseFloat(style.paddingLeft) || 8;

	if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
		const box = Math.min(rect.width, rect.height, 16);
		const bx = x + (rect.width - box) / 2;
		const by = y + (rect.height - box) / 2;
		ctx.strokeStyle = style.borderTopColor && !isTransparent(style.borderTopColor) ? style.borderTopColor : style.color;
		ctx.lineWidth = 1.5;
		ctx.strokeRect(bx, by, box, box);
		if (el.checked) {
			ctx.fillStyle = style.accentColor || style.color || '#fff';
			ctx.fillRect(bx + 3, by + 3, box - 6, box - 6);
		}
		return;
	}

	if (el instanceof HTMLInputElement && el.type === 'range') {
		const min = Number(el.min || 0);
		const max = Number(el.max || 100);
		const t = max > min ? (Number(el.value) - min) / (max - min) : 0;
		const cy = y + rect.height / 2;
		ctx.strokeStyle = 'rgba(255,255,255,0.35)';
		ctx.lineWidth = 4;
		ctx.beginPath();
		ctx.moveTo(x + 4, cy);
		ctx.lineTo(x + rect.width - 4, cy);
		ctx.stroke();
		ctx.fillStyle = style.accentColor || '#6366f1';
		ctx.beginPath();
		ctx.arc(x + 4 + t * (rect.width - 8), cy, 7, 0, Math.PI * 2);
		ctx.fill();
		return;
	}

	if (el instanceof HTMLInputElement && el.type === 'color') {
		ctx.fillStyle = el.value || '#000';
		ctx.fillRect(x + 4, y + 4, Math.max(0, rect.width - 8), Math.max(0, rect.height - 8));
		return;
	}

	let text = '';
	let faded = false;
	if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'file', 'image', 'hidden', 'checkbox', 'radio', 'range', 'color'].includes(el.type))) {
		text = el.value || el.placeholder || '';
		faded = !el.value;
	} else if (el instanceof HTMLSelectElement) {
		text = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
	} else {
		return;
	}
	if (!text) return;
	// Transparent text (the Code tab's textarea sits over the highlighted
	// <pre> with transparent text) paints nothing; it used to fillText the
	// whole program as one line on every refresh.
	const textFill = style.webkitTextFillColor || style.color;
	if (!faded && isTransparent(textFill)) return;
	// A form field shows one line here; never hand fillText a whole document.
	const nl = text.indexOf('\n');
	if (nl >= 0) text = text.slice(0, nl);
	if (text.length > 400) text = text.slice(0, 400);
	ctx.fillStyle = faded ? 'rgba(255,255,255,0.45)' : (style.color || '#fff');
	ctx.save();
	ctx.beginPath();
	ctx.rect(x, y, rect.width, rect.height);
	ctx.clip();
	ctx.fillText(text, x + padL, midY);
	ctx.restore();
}

function paintNode(ctx, el, ox, oy, clip) {
	if (!(el instanceof Element)) return;
	// Cull before getComputedStyle: anything entirely outside the current
	// overflow clip is invisible, and the clip below would discard it anyway.
	// This is what keeps a long, scrolled Code tab (thousands of highlight
	// spans) cheap. Zero-size boxes are kept: their children may still paint.
	const box = el.getBoundingClientRect();
	if (box.width > 0 && box.height > 0 && rectOutside(box, clip)) return;
	const style = getComputedStyle(el);
	if (style.display === 'none' || style.visibility === 'hidden') return;
	const opacity = parseFloat(style.opacity);
	if (Number.isFinite(opacity) && opacity <= 0.01) return;

	ctx.save();
	if (Number.isFinite(opacity) && opacity < 1) ctx.globalAlpha *= opacity;

	try {
		drawBackground(ctx, el, style, ox, oy);
		if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLSelectElement)) {
			drawDirectText(ctx, el, style, ox, oy, clip);
		}
		drawFormValue(ctx, el, style, ox, oy);
		// Canvas widgets in the menu (the Env tab's origin gizmo) are copied as pixels.
		if (el instanceof HTMLCanvasElement && el.width > 0 && el.height > 0 && box.width > 0 && box.height > 0) {
			ctx.drawImage(el, box.left - ox, box.top - oy, box.width, box.height);
		}
	} catch {
		// Keep painting the rest of the menu if one node can't be sampled.
	}

	let childClip = clip;
	if (clipsOverflow(style.overflowX) || clipsOverflow(style.overflowY)) {
		const rect = box;
		const bl = parseFloat(style.borderLeftWidth) || 0;
		const bt = parseFloat(style.borderTopWidth) || 0;
		const br = parseFloat(style.borderRightWidth) || 0;
		const bb = parseFloat(style.borderBottomWidth) || 0;
		ctx.beginPath();
		ctx.rect(
			rect.left - ox + bl,
			rect.top - oy + bt,
			Math.max(0, rect.width - bl - br),
			Math.max(0, rect.height - bt - bb)
		);
		ctx.clip();
		childClip = {
			left: Math.max(clip.left, rect.left + bl),
			top: Math.max(clip.top, rect.top + bt),
			right: Math.min(clip.right, rect.right - br),
			bottom: Math.min(clip.bottom, rect.bottom - bb)
		};
		if (childClip.right <= childClip.left || childClip.bottom <= childClip.top) {
			ctx.restore();
			return;
		}
	}

	for (const child of el.children) paintNode(ctx, child, ox, oy, childClip);
	ctx.restore();
}

/**
 * @param {Element} element
 * @param {HTMLCanvasElement} canvas
 * @param {{maxSize?: number}} [opts]
 * @returns {{width: number, height: number, scale: number}}
 */
export function paintElementToCanvas(element, canvas, opts = {}) {
	const maxSize = opts.maxSize || 1280;
	const rect = element.getBoundingClientRect();
	const width = Math.max(1, rect.width);
	const height = Math.max(1, rect.height);
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const scale = Math.min(dpr, maxSize / Math.max(width, height));
	const cw = Math.max(2, Math.round(width * scale));
	const ch = Math.max(2, Math.round(height * scale));
	if (canvas.width !== cw || canvas.height !== ch) {
		canvas.width = cw;
		canvas.height = ch;
	}
	const ctx = canvas.getContext('2d');
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	ctx.clearRect(0, 0, width, height);
	paintNode(ctx, element, rect.left, rect.top, {
		left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom
	});
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	return { width, height, scale };
}
