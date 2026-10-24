// Editable Scene chat prompt (Chat → Prompt).
//
// The default prompt comes from GET /api/prompts (server.js / the Worker, one
// source of truth). A saved edit is kept in localStorage and sent with Scene
// chat requests as `systemPrompt`; the server then uses it instead of the
// default and always appends its short required technical section
// (chatPromptRequired), so scene code keeps running. Fix-code and Theme
// prompts are shown read-only: their exact output formats are machine-parsed.

export const STORAGE_KEY = 'gs.customChatPrompt.v1';
export const FALLBACK_MAX_CHARS = 40000;

let defaults = null; // { systemPrompt, fixCodePrompt, themePrompt, chatPromptRequired, maxCustomPromptChars }
let custom = null; // saved custom prompt text, or null for the default
const listeners = new Set();

function readStored() {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return typeof v === 'string' && v.trim() ? v : null;
	} catch { return null; }
}
custom = readStored();

function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setDefaults(p) {
	if (!p || typeof p.systemPrompt !== 'string') return;
	defaults = p;
	// A saved copy that equals the (current) default is just the default.
	if (custom != null && custom.trim() === p.systemPrompt.trim()) clearCustom();
	emit();
}
export function getDefaults() { return defaults; }
export function maxChars() { return defaults?.maxCustomPromptChars || FALLBACK_MAX_CHARS; }
export function defaultPrompt() { return defaults?.systemPrompt || ''; }
export function getCustom() { return custom; }
export function isCustom() { return custom != null; }
/** The prompt the user sees in the editor: their saved one, or the default. */
export function currentText() { return custom ?? defaultPrompt(); }

/** Save text as the custom prompt. Empty or identical-to-default resets. Returns { ok, error }. */
export function saveCustom(text) {
	const t = String(text ?? '');
	if (!t.trim() || (defaults && t.trim() === defaults.systemPrompt.trim())) { clearCustom(); return { ok: true, reset: true }; }
	if (t.length > maxChars()) return { ok: false, error: `Too long: ${t.length.toLocaleString()} of ${maxChars().toLocaleString()} characters.` };
	custom = t;
	try { localStorage.setItem(STORAGE_KEY, t); } catch (e) { return { ok: false, error: 'Could not save (browser storage is full or blocked).' }; }
	emit();
	return { ok: true };
}
export function clearCustom() {
	const had = custom != null;
	custom = null;
	try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
	if (had) emit();
}

/** Extra fields for a POST /api/chat body. */
export function requestFields() { return custom != null ? { systemPrompt: custom } : {}; }

/** Full system prompt for backends the browser calls directly (Ollama). */
export function effectivePrompt() {
	if (custom == null) return defaultPrompt();
	const req = defaults?.chatPromptRequired;
	return req ? `${custom.trim()}\n\n${req}` : custom.trim();
}

// ---------------------------------------------------------------------------
// DOM view (Chat → Prompt). Elements live in index.html.

export function initPromptEditor({ onOpenPrompt, onStatus } = {}) {
	const $ = (id) => document.getElementById(id);
	const editor = $('dchat-prompt-editor');
	if (!editor) return null;
	const badge = $('dchat-prompt-badge');
	const count = $('dchat-prompt-count');
	const dirtyEl = $('dchat-prompt-dirty');
	const saveBtn = $('dchat-prompt-save');
	const revertBtn = $('dchat-prompt-revert');
	const resetBtn = $('dchat-prompt-reset');
	const msg = $('dchat-prompt-msg');
	const required = $('dchat-prompt-required');
	const fixPre = $('dchat-prompt-fix');
	const themePre = $('dchat-prompt-theme');
	const pill = $('dchat-custom-prompt-pill');
	const subtab = document.querySelector('#dchat-chat-subtabs [data-chat-section="prompt"]');

	let loadedText = null; // text the editor was last filled with (saved state)
	const dirty = () => loadedText != null && editor.value !== loadedText;

	function say(text, kind = '') {
		if (!msg) return;
		msg.textContent = text;
		msg.dataset.kind = kind;
	}
	function fill(force) {
		if (!force && dirty()) return; // never clobber unsaved typing
		const t = currentText();
		editor.value = t;
		loadedText = t;
	}
	function refresh() {
		const on = isCustom();
		const n = editor.value.length, max = maxChars();
		if (badge) {
			badge.textContent = on ? 'Custom prompt active' : 'Default prompt';
			badge.classList.toggle('is-custom', on);
		}
		if (count) {
			count.textContent = `${n.toLocaleString()} / ${max.toLocaleString()}`;
			count.classList.toggle('over', n > max);
		}
		const d = dirty();
		if (dirtyEl) dirtyEl.hidden = !d;
		if (saveBtn) saveBtn.disabled = !d || n > max || !defaults;
		if (revertBtn) revertBtn.disabled = !d;
		if (resetBtn) resetBtn.disabled = !on && !d;
		if (pill) pill.hidden = !on;
		if (subtab) subtab.classList.toggle('has-custom', on);
		document.documentElement.classList.toggle('gs-custom-prompt', on);
		if (required && defaults?.chatPromptRequired && required.textContent !== defaults.chatPromptRequired) required.textContent = defaults.chatPromptRequired;
		if (fixPre && defaults?.fixCodePrompt && !fixPre.textContent) fixPre.textContent = defaults.fixCodePrompt;
		if (themePre && defaults?.themePrompt && !themePre.textContent) themePre.textContent = defaults.themePrompt;
		editor.disabled = !defaults && !on;
		if (!defaults && !on) editor.placeholder = 'Loading the default prompt…';
	}

	function save() {
		const r = saveCustom(editor.value);
		if (!r.ok) { say(r.error, 'error'); refresh(); return false; }
		fill(true);
		say(r.reset ? 'Matches the default, so the default prompt is used.' : 'Saved. New Scene chat messages use this prompt.', 'ok');
		onStatus?.(r.reset ? 'Using the default prompt' : 'Custom prompt saved');
		refresh();
		return true;
	}
	function revert() { fill(true); say('Unsaved changes discarded.'); refresh(); }
	function reset() {
		if (isCustom() && !window.confirm('Reset the Scene chat prompt to the default? Your custom prompt will be deleted.')) return false;
		clearCustom();
		fill(true);
		say('Reset to the default prompt.', 'ok');
		onStatus?.('Using the default prompt');
		refresh();
		return true;
	}

	editor.addEventListener('input', () => { say(''); refresh(); });
	editor.addEventListener('keydown', (e) => {
		if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (!saveBtn?.disabled) save(); }
	});
	saveBtn?.addEventListener('click', save);
	revertBtn?.addEventListener('click', revert);
	resetBtn?.addEventListener('click', reset);
	pill?.addEventListener('click', () => onOpenPrompt?.());
	// Keep the on-screen keyboard up when tapping the action buttons on phones.
	for (const b of [saveBtn, revertBtn]) b?.addEventListener('mousedown', (e) => { if (document.activeElement === editor) e.preventDefault(); });

	onChange(() => { fill(false); refresh(); });
	// Another tab saved or reset the prompt.
	window.addEventListener('storage', (e) => {
		if (e.key !== STORAGE_KEY) return;
		custom = readStored();
		fill(false);
		refresh();
	});
	fill(true);
	refresh();
	return { save, revert, reset, refresh, isDirty: dirty, editor };
}
