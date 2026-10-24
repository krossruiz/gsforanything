/**
 * Shared declarative menu buttons.
 *
 * Each panel's buttons are described as plain data (see the *_BUTTONS specs
 * in main.js). buildButtonLayout() lays them out (wrapping rows, like CSS
 * flex-wrap) and buttonsToSVG() renders them as a real, interactive <svg>
 * inside the menu. In VR the same menu element is painted into the headset
 * (htmlInCanvas.js / vrWindows.js), so there is one rendering path for
 * desktop, phone and VR.
 *
 * Colours meet WCAG AA on the menu panel: white labels are >= 4.5:1 on every
 * fill (both gradient stops) and every button carries a >= 3:1 boundary
 * stroke; the selected ('active') toggle gets a light stroke as well as a fill.
 */

export const VARIANT_COLORS = {
	default: { fill: 'rgba(255,255,255,0.12)', text: '#ffffff', stroke: '#70738c' },
	secondary: { fill: 'rgba(255,255,255,0.12)', text: '#ffffff', stroke: '#70738c' },
	accent: { fill1: '#4f46e5', fill2: '#6d28d9', text: '#ffffff', stroke: '#70738c' },
	success: { fill1: '#047857', fill2: '#065f46', text: '#ffffff', stroke: '#70738c' },
	warning: { fill1: '#b45309', fill2: '#92400e', text: '#ffffff', stroke: '#70738c' },
	active: { fill: '#047857', text: '#ffffff', stroke: '#c7d2fe' },
	inactiveToggle: { fill: 'rgba(255,255,255,0.12)', text: 'rgba(255,255,255,0.8)', stroke: '#70738c' }
};
const STROKE_W = 1.5;

/**
 * Lays out a row of buttons that wraps like `flex-wrap: wrap`.
 * @param {Array<{id:string,label:string,action:string,variant?:string}>} buttons
 * @param {{width:number,x?:number,y?:number,gap?:number,height?:number,minWidth?:number,perRow?:number}} opts
 * @returns {{boxes: Array<object>, totalHeight: number}}
 */
export function buildButtonLayout(buttons, opts) {
	const { width, x = 0, y = 0, gap = 8, height = 50, minWidth = 100, perRow = null } = opts;
	const cols = Math.max(1, perRow || Math.floor((width + gap) / (minWidth + gap)));
	const colW = (width - gap * (cols - 1)) / cols;

	const boxes = buttons.map((btn, i) => {
		const col = i % cols;
		const row = Math.floor(i / cols);
		return {
			...btn,
			x: x + col * (colW + gap),
			y: y + row * (height + gap),
			w: colW,
			h: height
		};
	});

	const rows = Math.ceil(buttons.length / cols) || 1;
	const totalHeight = rows * height + (rows - 1) * gap;
	return { boxes, totalHeight };
}

function escapeXml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders button boxes to an SVG markup fragment (no outer <svg> tag - the
 * caller wraps it with the right viewBox/size for its container).
 */
export function buttonsToSVG(boxes, { fontSize = 13, radius = 10 } = {}) {
	const defs = [];
	const groups = boxes.map(b => {
		const v = VARIANT_COLORS[b.variant] || VARIANT_COLORS.default;
		let fill = v.fill;
		if (v.fill1) {
			const gradId = `grad-${b.id}`;
			defs.push(`<linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${v.fill1}"/><stop offset="1" stop-color="${v.fill2}"/></linearGradient>`);
			fill = `url(#${gradId})`;
		}
		return `<g class="menu-btn" data-action="${escapeXml(b.action)}" data-id="${escapeXml(b.id)}" tabindex="0" role="button" style="cursor:pointer">` +
			`<rect x="${b.x + STROKE_W / 2}" y="${b.y + STROKE_W / 2}" width="${Math.max(0, b.w - STROKE_W)}" height="${Math.max(0, b.h - STROKE_W)}" rx="${radius}" fill="${fill}" stroke="${v.stroke}" stroke-width="${STROKE_W}" />` +
			`<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2}" fill="${v.text}" font-size="${fontSize}" font-weight="700" ` +
			`font-family="-apple-system,BlinkMacSystemFont,sans-serif" text-anchor="middle" dominant-baseline="central">${escapeXml(b.label)}</text>` +
			`</g>`;
	});
	const defsMarkup = defs.length ? `<defs>${defs.join('')}</defs>` : '';
	return defsMarkup + groups.join('');
}

/**
 * Mounts a button spec into a DOM container as a live, interactive SVG, and
 * wires a single delegated click handler that calls `onAction(action, id)`.
 * Returns the box layout.
 */
export function mountButtonsToDOM(container, buttons, layoutOpts, onAction) {
	const { boxes, totalHeight } = buildButtonLayout(buttons, layoutOpts);
	const svgBody = buttonsToSVG(boxes, { fontSize: layoutOpts.fontSize });
	container.innerHTML = `<svg viewBox="0 0 ${layoutOpts.width} ${totalHeight}" width="100%" style="display:block" preserveAspectRatio="xMidYMid meet">${svgBody}</svg>`;
	container.onclick = (e) => {
		const g = e.target.closest('[data-action]');
		if (!g) return;
		onAction(g.getAttribute('data-action'), g.getAttribute('data-id'));
	};
	return { boxes, totalHeight };
}
