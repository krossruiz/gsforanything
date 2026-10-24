import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { networkInterfaces } from 'os';
import https from 'https';
import dns from 'dns';
import fs from 'fs';
import selfsigned from 'selfsigned';
import { randomBytes } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// WebXR requires a "secure context" — https, or the special-cased
// http://localhost. A plain http:// LAN IP (e.g. http://192.168.x.x) does
// NOT count, so the Quest browser could never start an XR session against
// it. The server therefore always listens over HTTPS (self-signed cert,
// generated on first run).

// Which model backend to use by default: 'claude', 'openai', or 'ollama'.
// The client can override this per-request (see the model dropdown in the
// chat UI) - this is just the fallback when a request doesn't specify one.
const LLM_BACKEND = (process.env.LLM_BACKEND || 'openai').toLowerCase();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-astra';
// Documented OpenAI chat-completions id (developers.openai.com/api/docs/models/gpt-6.1-sol).
// Not overridden by OPENAI_MODEL, which only replaces the Astra default above.
const OPENAI_SOL_MODEL = 'gpt-6.1-sol';

// API keys - each backend is only usable if its key is configured. This
// intentionally does NOT exit at startup when a key is missing: unlike the
// old single-backend design, several backends can be available at once now
// (selected per-request from the client dropdown), so a missing OpenAI key
// should just gray out that option, not crash the whole server.
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Ollama is NOT proxied through this server. The server has no network path
// to a user's own machine when this app is deployed on Vercel - "localhost"
// from the server's perspective is the Vercel container, not the visitor's
// laptop. Instead the *browser* calls the user's local Ollama directly
// (http://localhost:11434), which actually is on the same machine as the
// browser regardless of whether this page is loaded from Vercel or run
// locally. See listOllamaModels()/callOllamaDirect() in main.js. Ollama
// allows localhost origins by default; reaching it from the hosted
// vrclaudeinterface.vercel.app origin requires the user to start Ollama
// with OLLAMA_ORIGINS including that origin (or "*").
// Backend key -> provider/model/label. Order here is dropdown order (newest/
// best first within each provider). Keys are stable: saved/sent `backend`
// values must keep resolving, so never rename an existing key.
const BACKENDS = {
	'claude-opus-55': { provider: 'claude', model: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
	'claude-sonnet-55': { provider: 'claude', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
	'claude-haiku-55': { provider: 'claude', model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
	fable: { provider: 'claude', model: 'claude-fable-5-1', label: 'Claude (Fable 5.1)' },
	claude: { provider: 'claude', model: 'claude-sonnet-5', label: 'Claude (Sonnet 5)' },
	'openai-sol': { provider: 'openai', model: OPENAI_SOL_MODEL, label: 'GPT6.1 Sol' },
	'openai-6-sol': { provider: 'openai', model: 'gpt-6-sol', label: 'GPT6 Sol' },
	'openai-luna': { provider: 'openai', model: 'gpt-6-luna', label: 'GPT6 Luna' },
	// OPENAI_MODEL env override applies to this key only.
	openai: { provider: 'openai', model: OPENAI_MODEL, label: 'GPT6 Astra' },
	ollama: { provider: 'ollama', label: 'Ollama (runs in your browser, local)', local: true },
};

function getAvailableBackends() {
	const out = {};
	for (const [id, b] of Object.entries(BACKENDS)) {
		const available = b.provider === 'ollama' ? true : b.provider === 'openai' ? !!OPENAI_API_KEY : !!CLAUDE_API_KEY;
		out[id] = { label: b.label, provider: b.provider, available, ...(b.local ? { local: true } : {}) };
	}
	return out;
}

if (!CLAUDE_API_KEY && !OPENAI_API_KEY) {
	console.error('\x1b[31mWarning: neither CLAUDE_API_KEY nor OPENAI_API_KEY is set.\x1b[0m');
	console.error('Set at least one before running the server, e.g.:');
	console.error('  Windows:  set CLAUDE_API_KEY=your-key-here');
	console.error('  Mac/Linux: export CLAUDE_API_KEY=your-key-here');
	console.error('Or select Ollama in the model dropdown to use a local model instead.');
}

// Middleware
app.use(cors());
// 25mb: chat requests can now carry a handful of base64-encoded image
// attachments (each ~33% larger than its raw file size once encoded).
app.use(express.json({ limit: '25mb' }));

// Serve static files
app.use(express.static(__dirname));

// System prompt for VR scene coding assistant
const SYSTEM_PROMPT = `You are a coding assistant embedded in a WebXR VR environment built with Three.js. Your role is to help the user modify the VR scene by writing and injecting code.

## Environment

The scene is a Three.js WebXR application. You have access to these globals when your code runs:
- \`THREE\` — the Three.js library
- \`scene\` — the THREE.Scene instance
- \`camera\` — the THREE.PerspectiveCamera
- \`renderer\` — the THREE.WebGLRenderer (XR-enabled)
- \`document\` — the page DOM (you can inject HTML elements into #overlay-root for DOM overlay UI)
- \`hud\` — a group attached to the camera (head-locked). Add objects here ONLY when the user explicitly asks for a HUD / an element that follows them. Never use it by default.
- \`gs\` — hot-reload helpers for this block (see "Hot reload" below).

## Hot reload (keep state when code is edited)

The user can edit any block in the Code tab; on Apply / Live updates only the changed block is torn down and re-run, and the rest of the scene keeps running. Write blocks so that works:
- Keep score, counters, timers and other mutable state in \`gs.state\` (per block) or \`window.gsState\` (shared): initialise with \`gs.state.score ??= 0;\` so a reload keeps the value.
- Register per-frame code with \`gs.onUpdate((time) => { ... })\` (same as pushing onto \`window._vrAnimations\`, but cleanly replaced on reload).
- Give every object you create a unique, stable \`name\` (\`mesh.name = 'ball'\`). Position, rotation, scale and \`mesh.userData.velocity\` (a THREE.Vector3) of named objects carry over a reload unless the code's start value changed. For ammo.js, set \`mesh.userData.physicsBody = body\` so the body's transform and velocity carry over too, and reuse the world with \`window.physicsWorld ??= new Ammo.btDiscreteDynamicsWorld(...)\`.
- Use \`gs.on(target, 'event', fn)\` for event listeners and plain \`setTimeout\` / \`setInterval\` (they are scoped to the block); \`gs.onDispose(fn)\` runs before the block is replaced. \`gs.hot\` is true on a reload.

## Libraries, editor settings and page helpers

The page also provides these window globals:
- \`gsRequire(name)\` — async; resolves to a library from the Dependencies tab: \`'ammo'\` (ammo.js / Bullet physics, already initialised — use \`const Ammo = await gsRequire('ammo');\`, never call \`Ammo()\` yourself), \`'p5'\` (the p5.js constructor, instance mode only) or \`'three'\`.
- \`gsCreateCanvasSurface({ context: '2d' | 'webgl2', width, height, widthMeters, position })\` — a canvas shown on a panel in the scene (works in a headset), re-uploaded every frame. Returns \`{ canvas, ctx, gl, mesh, texture, dispose() }\`.
- \`await gsCreateP5Surface((p) => { p.setup = ...; p.draw = ...; }, opts)\` — a p5.js sketch shown on such a panel; the app drives \`p.draw\` every frame.
- Pointer input on these panels works everywhere, including in a headset: pointing a VR controller (or hand) at the panel and pulling the trigger / pinching, or clicking / tapping it in the 3D view, sends pointer and mouse events to the canvas at the matching pixel. p5's \`mouseX\`, \`mouseY\`, \`mouseIsPressed\`, \`mousePressed()\`, \`mouseReleased()\`, \`mouseDragged()\` and \`mouseClicked()\` work, as do \`canvas.addEventListener('pointerdown' | 'mousedown' | 'click', ...)\` with \`e.offsetX/e.offsetY\` in canvas pixels.
- \`gsGamepad\` — game controllers (Xbox / PlayStation / other USB or Bluetooth pads via the Gamepad API): \`connected\`, \`axis('leftX' | 'leftY' | 'rightX' | 'rightY')\`, \`button(name)\`, \`pressed(name)\`, \`justPressed(name)\`, \`onButton(name, fn)\`, \`rumble(ms, strength)\`, and \`captureCamera = true\` to stop the sticks moving the editor camera. Headset (WebXR) controllers are separate.
- Desktop camera controls are the stock three.js addons, owned by the app — never create your own OrbitControls / PointerLockControls / FlyControls or add WASD / mouse-look camera code. The user picks the mode in the Controls tab: Orbit (OrbitControls, default, target at the scene origin 0,0,0), Map (MapControls), Trackball, Fly (FlyControls), First person (PointerLockControls + WASD) or Off. From code: \`window.gsControls.mode\`, \`gsControls.controls\` (the active control instance, also \`window.controls\`; \`null\` when Off), \`gsControls.setMode('orbit' | 'map' | 'trackball' | 'fly' | 'firstperson' | 'off')\` only when the user asks for a mode, \`gsControls.reset()\` to restore the default view, and \`gsOrbit.pivot()\` / \`gsOrbit.recenter()\`. Keyboard keys reach the controls except while a text field is focused; in VR the headset drives the camera.

When the scene needs physics (gravity, collisions, rigid bodies), use ammo.js through \`gsRequire('ammo')\`: one \`btDiscreteDynamicsWorld\` stored on \`window\`, stepped in a \`window._vrAnimations\` callback, copying each body's transform onto its mesh every frame.

A user message may start with a "[GS editor settings: ...]" note. It carries the user's chosen Environment (2D with p5.js or a blank canvas, or 3D with THREE.js or raw WebGL) and which Dependencies are on. Follow it unless the message itself asks for something else, and don't mention the note.

## Coordinate system (IMPORTANT)

This session requests a \`local-floor\` reference space. In WebXR, the floor position is accessed by requesting a \`local-floor\` or \`bounded-floor\` reference space. These spaces initialize the origin at floor level, where the y-axis is 0 at the ground, x is horizontal, and z is depth. \`local-floor\` provides a stable ground reference, while \`bounded-floor\` includes physical boundaries.

Concretely for this app:
- **y = 0 is the real-world floor** in the user's AR space.
- **y ≈ 1.6** is roughly the user's eye level (standing).
- **z is negative going forward** (away from the user); the user faces \`-z\` by default.

Place objects at heights that match where they belong in real life:
- Floors, rugs, ground planes → y = 0 (NEVER at eye level — this is a common mistake).
- Tabletop objects → y ≈ 0.7–0.9 (table height).
- Wall art / framed objects → y ≈ 1.4–1.7.
- Floating UI panels facing the user → y ≈ 1.4 and z ≈ -1.5.
- Ceiling objects → y ≈ 2.4+.

Do NOT default to y = 1.5 for everything. The chat/input/scene panels already sit there; piling new objects at the same height clutters the user's face. When in doubt about a specific object, think about where it would be in a real room and use that y.

When generating something *the user stands on or walks around* (a floor, a platform, a path), build it at y = 0 and give it explicit width/depth — for example a floor:

\`\`\`vr-exec
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(6, 6),
  new THREE.MeshStandardMaterial({ color: 0x6b7280, side: THREE.DoubleSide })
);
floor.rotation.x = -Math.PI / 2;  // lay flat on the ground plane
floor.position.set(0, 0, 0);       // y = 0 = AR floor
scene.add(floor);
\`\`\`

## Anchoring (IMPORTANT — default behavior)

Objects you add with \`scene.add(...)\` are anchored to the physical room (the larger environmental scene). They stay fixed in world space as the user walks around, turns their head, or looks away — they are NOT attached to the chat window or the user. **This is the default and what you must do unless the user explicitly asks otherwise.** Set a world position once with \`obj.position.set(x, y, z)\` and leave it there.

Do NOT make new objects follow, attach to, or move with the user or the chat window by default:
- Never parent an object to \`camera\` (e.g. \`camera.add(obj)\`).
- Never register a \`window._vrAnimations\` callback that copies \`camera.position\`/rotation onto an object, or calls \`obj.lookAt(camera.position)\` every frame, just to keep it in front of the user.
- Never recompute an object's position from \`camera\` every frame.

Only when the user *explicitly* asks for a head-locked HUD, a "follow me" panel, or an element that always faces them should you make it follow — and in that case add it to the \`hud\` group (\`hud.add(obj)\`), which is attached to the camera and will track the user. Its \`position\` is relative to the camera (e.g. \`obj.position.set(0, 0, -1)\` places it 1m in front). Do NOT parent to \`camera\` directly — objects added straight to \`camera\` are automatically re-anchored to the world. Everything not in \`hud\` stays world-anchored via \`scene.add(...)\`.

## Photorealistic lighting and materials (default look)

Unless the user asks for a flat, cartoon, toon or unlit style, light and shade scenes like a photograph. Avoid flat lighting where every surface is equally bright.

Lighting:
- The app adds a soft default ambient light (\`scene.getObjectByName('gsDefaultAmbient')\`, intensity 0.6) and a white key light (\`gsDefaultKey\`). When you light a scene yourself, turn the ambient down to about 0.1–0.2 (and the default key to 0 if you add your own) instead of piling on more even light.
- Use one motivated key light (sun through a window, a lamp, a stage spot): a \`DirectionalLight\` or \`SpotLight\` with \`castShadow = true\`. Add a weaker fill from the other side (about a quarter to a third of the key, no shadows). Keep any \`HemisphereLight\` / \`AmbientLight\` low. Aim for contrast: pools of light and soft shadow, darker corners, a brighter subject.
- Shadows: \`renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;\`. Set \`castShadow\` on objects and \`receiveShadow\` on floors and walls. Fit the shadow camera to the scene (\`light.shadow.camera.left/right/top/bottom\` about ±5 m, tight \`near\`/\`far\`), use \`light.shadow.mapSize.set(1024, 1024)\` (2048 at most), \`light.shadow.bias = -0.0005\` and \`light.shadow.normalBias = 0.02\`, and \`scene.add(light.target)\`.
- Intensities are physical (three.js r155+): point and spot lights use candela with inverse-square falloff (\`decay = 2\`), so a lamp 1–3 m away needs about 5–50, and \`distance\` limits its reach. A sun-like \`DirectionalLight\` is about 1–3.
- Reflections: give metals and glossy surfaces something to reflect (skip this if \`scene.environment\` is already set, e.g. by an HDRI from the Environment tab):
  \`const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');\`
  \`scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.4;\`
  Keep \`environmentIntensity\` modest so it doesn't flatten the lighting.
- Tone mapping: \`renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1; renderer.outputColorSpace = THREE.SRGBColorSpace;\`.
- For depth, optional fog that matches the background: \`scene.fog = new THREE.Fog(color, near, far)\`.

Materials:
- Use \`MeshStandardMaterial\`, or \`MeshPhysicalMaterial\` for clearcoat (car paint, varnish), \`transmission\` + \`ior\` + \`thickness\` (glass, water, ice) and \`sheen\` (fabric, velvet). Don't use MeshBasic / Lambert / Phong for lit objects.
- Realistic values: metals \`metalness: 1\`, roughness 0.2–0.5; plastic and paint metalness 0, roughness 0.4–0.7; wood 0.6–0.8; stone and concrete 0.8–0.95; rubber and cloth 0.9+. Vary roughness and colour a little between objects, and avoid pure white or pure black base colours.
- With no texture files, add surface detail with a small \`CanvasTexture\` (noise, grain, tiles, scratches) as \`map\`, \`roughnessMap\` or \`bumpMap\`, with \`wrapS = wrapT = THREE.RepeatWrapping\` and a \`repeat\`.
- Colour spaces: colour textures (\`map\`, \`emissiveMap\`) get \`texture.colorSpace = THREE.SRGBColorSpace\`. Data textures (roughness, metalness, normal, bump) stay linear.

VR performance (Quest): at most one or two shadow-casting lights, shadow maps of 1024 or less, few dynamic lights, and no post-processing (EffectComposer, bloom, SSAO) in VR. It drops the frame rate badly in a headset.

## How to modify the scene

When you want to modify the VR scene or inject HTML, wrap your code in a fenced code block with the language tag \`vr-exec\`:

\`\`\`vr-exec
// Example: add a red cube
const geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
const cube = new THREE.Mesh(geometry, material);
cube.position.set(0, 1.5, -2);
scene.add(cube);
\`\`\`

You can also inject HTML into the DOM overlay:

\`\`\`vr-exec
const panel = document.createElement('div');
panel.id = 'my-info-panel';
panel.style.cssText = 'position:fixed;top:80px;left:20px;padding:16px;background:rgba(0,0,0,0.8);color:white;border-radius:12px;z-index:1000;font-size:14px;';
panel.innerHTML = '<h3>Scene Info</h3><p>Objects: ' + scene.children.length + '</p>';
document.getElementById('overlay-root').appendChild(panel);
\`\`\`

## Rules

1. Always use \`vr-exec\` code blocks for code that should be executed in the scene. Regular code blocks are displayed but NOT executed.
2. You can include multiple \`vr-exec\` blocks in a single response — they execute in order.
3. You can use animation by hooking into the render loop: \`gs.onUpdate(fn)\` (preferred, hot-reload safe) or push functions onto \`window._vrAnimations\` — the app calls each one per frame.
4. Keep explanations concise. Lead with the code, explain after.
5. When removing objects, use \`scene.remove(obj)\` and \`obj.geometry.dispose(); obj.material.dispose();\` to free memory.
6. To reference objects you've previously added, attach them to \`window\` (e.g., \`window.myCube = cube;\`).
7. For embedded <script> tags in injected HTML, they will be executed automatically by the browser.
8. The user is in VR/AR on a Quest 3 headset — keep UI elements readable and appropriately sized.
9. vr-exec blocks run inside an async function, so you can use \`await\` at the top level.
10. By default, anchor new objects to the world with \`scene.add(...)\` and a fixed \`position\`. Do NOT parent them to \`camera\` or add per-frame code that makes them follow the user, unless the user explicitly requests a head-locked or always-facing element (see "Anchoring" above).`;

// The Scene chat prompt is viewable and editable in the app (Chat → Prompt).
// A custom prompt replaces SYSTEM_PROMPT for /api/chat; GS always appends
// CHAT_PROMPT_REQUIRED to it so scene code keeps running however it was edited.
// Kept short on purpose. Copied into the Worker by worker/gen-prompts.mjs.
const MAX_CUSTOM_PROMPT_CHARS = 40000;
const CHAT_PROMPT_REQUIRED = `## GS technical requirements (always added by GS; not editable)

- Code that should change the scene must be in fenced code blocks tagged \`vr-exec\` (\`\`\`vr-exec ... \`\`\`). Other code blocks are shown, not run. Several vr-exec blocks run in order.
- vr-exec blocks run inside an async function (top-level \`await\` works) with these globals: \`THREE\`, \`scene\`, \`camera\`, \`renderer\`, \`document\`, \`hud\` (head-locked group, only on request) and \`gs\` (\`gs.state\`, \`gs.onUpdate(fn)\`, \`gs.on(target, event, fn)\`, \`gs.onDispose(fn)\`). The page also has \`gsRequire\`, \`gsCreateCanvasSurface\`, \`gsCreateP5Surface\`, \`gsGamepad\` and \`gsControls\`.
- y = 0 is the floor, eye level is about 1.6 m, and the user faces -z. Don't create your own camera controls.
- A user message may start with a "[GS editor settings: ...]" note. Follow it and don't mention it.`;

// Returns the system prompt for a /api/chat request: the default, or the
// user's custom prompt plus the required technical section.
function resolveChatPrompt(custom) {
	if (custom == null || custom === '') return { prompt: SYSTEM_PROMPT, custom: false };
	if (typeof custom !== 'string') return { error: 'systemPrompt must be a string' };
	if (!custom.trim()) return { prompt: SYSTEM_PROMPT, custom: false };
	if (custom.length > MAX_CUSTOM_PROMPT_CHARS) return { error: `Custom prompt is too long (${custom.length} characters, max ${MAX_CUSTOM_PROMPT_CHARS}). Shorten it in Chat → Prompt.` };
	return { prompt: `${custom.trim()}\n\n${CHAT_PROMPT_REQUIRED}`, custom: true };
}

// System prompt for error-correction requests
const FIX_CODE_PROMPT = `You are an automatic error-correction system for a WebXR VR environment built with Three.js.

A vr-exec code block failed to execute. Your job is to fix the code and return ONLY a corrected version.

## Environment

The code runs inside an \`AsyncFunction('THREE', 'scene', 'camera', 'renderer', 'document', 'hud', 'gs', code)\`, so these are the ONLY variables available:
- \`THREE\` — the Three.js library (use THREE.* for all Three.js classes/utilities)
- \`scene\` — THREE.Scene instance
- \`camera\` — THREE.PerspectiveCamera
- \`renderer\` — THREE.WebGLRenderer (XR-enabled)
- \`document\` — the page DOM
- \`window\` — the global window object (use window.* to access/store persistent references)
- \`window._vrAnimations\` — array of per-frame animation callbacks
- \`gs\` — hot-reload helpers: \`gs.state\` (persistent per-block object), \`gs.onUpdate(fn)\`, \`gs.on(target, type, fn)\`, \`gs.onDispose(fn)\`, \`gs.hot\`; also \`window.gsState\`. Valid — keep using them, and keep stable \`name\`s on objects.
- \`window.gsRequire(name)\` (async; \`'ammo'\` → initialised ammo.js, \`'p5'\` → p5 constructor), \`window.gsCreateCanvasSurface(opts)\`, \`window.gsCreateP5Surface(sketch, opts)\` \`window.gsGamepad\`, \`window.gsControls\` / \`window.controls\` (the app's stock three.js camera controls) and \`window.gsOrbit\` — page helpers; these are valid, keep using them. Never call \`Ammo()\` directly: use \`const Ammo = await gsRequire('ammo');\`

Top-level \`await\` IS allowed because the function is async.

## Common mistakes to fix

1. Using bare globals that aren't passed in (e.g. \`Math\` is fine since it's on window, but any custom var from a prior block must be accessed via \`window.varName\`)
2. Using Three.js classes without the \`THREE.\` prefix (e.g. \`Vector3\` → \`THREE.Vector3\`, \`MeshStandardMaterial\` → \`THREE.MeshStandardMaterial\`)
3. Referencing variables from other code blocks without \`window.\` prefix
4. Using ES module import syntax (not available inside new Function)
5. Using \`let\`/\`const\` for variables that need to persist across blocks — should use \`window.varName\` instead
6. Accessing Three.js addon classes (like OrbitControls, FontLoader, TextGeometry) that aren't available in the base Three.js build (for camera controls use the app's \`window.gsControls\` / \`window.controls\` instead of constructing OrbitControls)

## Rules

1. Return ONLY a single \`vr-exec\` code block with the fix. No explanation, no commentary.
2. Fix the root cause — don't just wrap in try/catch to silence it.
3. If the code references variables from prior code blocks, access them via \`window.\` (e.g. \`window.myCube\`).
4. If Three.js addon classes are needed but unavailable, replace with equivalent base Three.js code (e.g. replace TextGeometry with canvas texture text, replace CSG with manual geometry).
5. Keep the original intent of the code intact.`;

// Thinking tokens Fable 5.1 is allowed to spend before it must produce its
// answer - see the comment below for why this has to be bounded.
const FABLE_THINKING_BUDGET = 4096;

// Shared function: call Claude API and return parsed response
function callClaudeAPI(systemPrompt, messages, maxTokens = 16384, model = 'claude-sonnet-5') {
	return new Promise((resolve, reject) => {
		const isFable = model === 'claude-fable-5-1';
		const postBody = JSON.stringify({
			model,
			// Fable 5.1: max_tokens is a shared cap over thinking + the actual
			// answer. Left alone (adaptive thinking, unbounded within max_tokens),
			// a harder prompt can spend the whole budget thinking and hit
			// max_tokens before writing any answer text at all - the response
			// still comes back 200 OK, just with no text block, which looked like
			// the request "hanging" / getting no response. Explicitly bounding
			// the thinking budget and adding it on top of max_tokens guarantees
			// maxTokens' worth of room is always left for the answer itself.
			max_tokens: isFable ? maxTokens + FABLE_THINKING_BUDGET : maxTokens,
			// Thinking is on by default on Sonnet 5; disable it to keep VR latency low.
			...(model === 'claude-sonnet-5' ? { thinking: { type: 'disabled' } } : {}),
			// Fable 5.1 rejects thinking.type "enabled"; adaptive + effort is required.
			...(isFable ? { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } } : {}),
			system: systemPrompt,
			messages: messages
		});

		const apiReq = https.request({
			hostname: 'api.anthropic.com',
			path: '/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': CLAUDE_API_KEY,
				'anthropic-version': '2023-06-01',
				'Content-Length': Buffer.byteLength(postBody)
			},
			lookup: (hostname, options, callback) => {
				if (typeof options === 'function') {
					callback = options;
					options = {};
				}
				dns.resolve4(hostname, (err, addresses) => {
					if (err) return callback(err);
					if (options && options.all) {
						callback(null, addresses.map(addr => ({ address: addr, family: 4 })));
					} else {
						callback(null, addresses[0], 4);
					}
				});
			}
		}, (apiRes) => {
			let body = '';
			apiRes.on('data', (chunk) => body += chunk);
			apiRes.on('end', () => {
				try {
					const parsed = JSON.parse(body);
					if (apiRes.statusCode >= 400) {
						resolve({ error: true, status: apiRes.statusCode, data: parsed });
					} else {
						// Adaptive-thinking models (Fable 5.1) can put a "thinking"
						// block before the "text" block - reorder so content[0] is
						// always the text block, since the client reads it directly.
						if (Array.isArray(parsed.content)) {
							const textBlock = parsed.content.find(b => b.type === 'text');
							if (textBlock && parsed.content[0] !== textBlock) {
								parsed.content = [textBlock, ...parsed.content.filter(b => b !== textBlock)];
							}
						}
						resolve({ error: false, data: parsed });
					}
				} catch (e) {
					reject(new Error(`Invalid JSON response: ${body.slice(0, 200)}`));
				}
			});
		});

		apiReq.on('error', reject);
		apiReq.write(postBody);
		apiReq.end();
	});
}

// Shared function: call the OpenAI API and normalize the response into the
// same { content: [{ text }] } shape the client expects from Claude.
function callOpenAIAPI(systemPrompt, messages, maxTokens = 16384, model = OPENAI_MODEL) {
	return new Promise((resolve, reject) => {
		const postBody = JSON.stringify({
			model,
			max_completion_tokens: maxTokens,
			messages: [
				{ role: 'system', content: systemPrompt },
				...messages.map(m => ({ role: m.role, content: m.content }))
			]
		});

		const apiReq = https.request({
			hostname: 'api.openai.com',
			path: '/v1/chat/completions',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${OPENAI_API_KEY}`,
				'Content-Length': Buffer.byteLength(postBody)
			}
		}, (apiRes) => {
			let body = '';
			apiRes.on('data', (chunk) => body += chunk);
			apiRes.on('end', () => {
				try {
					const parsed = JSON.parse(body);
					if (apiRes.statusCode >= 400) {
						resolve({ error: true, status: apiRes.statusCode, data: { error: { message: parsed.error?.message || body } } });
					} else {
						const text = parsed.choices?.[0]?.message?.content || '';
						resolve({ error: false, data: { content: [{ text }] } });
					}
				} catch (e) {
					reject(new Error(`Invalid JSON response from OpenAI: ${body.slice(0, 200)}`));
				}
			});
		});

		apiReq.on('error', reject);
		apiReq.write(postBody);
		apiReq.end();
	});
}

// Dispatches to whichever backend was requested (falls back to LLM_BACKEND
// if the client didn't specify one), keeping a uniform response shape.
function callLLM(systemPrompt, messages, maxTokens = 16384, backend) {
	const chosen = (backend || LLM_BACKEND).toLowerCase();

	if (chosen === 'ollama') {
		// The client should never actually send this - Ollama requests go
		// straight from the browser to the user's local Ollama and never
		// touch this endpoint. This only fires if that client-side branch
		// was somehow bypassed.
		return Promise.resolve({ error: true, status: 400, data: { error: { message: 'Ollama requests should go directly from the browser to localhost:11434, not through this server.' } } });
	}

	// Unknown keys fall back to Claude Sonnet 5 (the old default behavior).
	const entry = BACKENDS[chosen] || BACKENDS.claude;
	if (entry.provider === 'openai') {
		if (!OPENAI_API_KEY) return Promise.resolve({ error: true, status: 400, data: { error: { message: 'OPENAI_API_KEY is not configured on the server.' } } });
		return callOpenAIAPI(systemPrompt, messages, maxTokens, entry.model);
	}

	if (!CLAUDE_API_KEY) return Promise.resolve({ error: true, status: 400, data: { error: { message: 'CLAUDE_API_KEY is not configured on the server.' } } });
	const model = entry.model;
	return callClaudeAPI(systemPrompt, messages, maxTokens, model);
}

// Tells the client which backends are actually usable, to populate the model dropdown.
app.get('/api/backends', (req, res) => {
	res.json({ backends: getAvailableBackends(), default: LLM_BACKEND });
});

// The system prompts, for the client to use when calling Ollama directly
// (bypassing this server entirely) so there's still one source of truth for
// them instead of a duplicated copy baked into main.js.
app.get('/api/prompts', (req, res) => {
	res.json({ systemPrompt: SYSTEM_PROMPT, fixCodePrompt: FIX_CODE_PROMPT, themePrompt: THEME_SYSTEM_PROMPT, chatPromptRequired: CHAT_PROMPT_REQUIRED, maxCustomPromptChars: MAX_CUSTOM_PROMPT_CHARS });
});

// Read-only relay for public p5.js web editor sketches. editor.p5js.org
// doesn't send CORS headers to other sites, so the "Import p5 sketch" URL
// option can't fetch editor.p5js.org/<user>/sketches/<id> from the browser.
// This fetches only that one public project-JSON endpoint (username and id
// are validated, nothing else is reachable) and returns its JSON.
app.get('/api/p5-editor/:user/:id', async (req, res) => {
	const { user, id } = req.params;
	if (!/^[A-Za-z0-9_.-]{1,64}$/.test(user) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
		return res.status(400).json({ error: 'Invalid p5 editor username or sketch id' });
	}
	try {
		const upstream = await fetch(`https://editor.p5js.org/editor/${encodeURIComponent(user)}/projects/${encodeURIComponent(id)}`, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(15000)
		});
		if (upstream.status === 404) return res.status(404).json({ error: 'Sketch not found', notFound: true });
		if (!upstream.ok) return res.status(502).json({ error: `p5 editor returned HTTP ${upstream.status}` });
		const data = await upstream.json();
		if (!data || !Array.isArray(data.files)) return res.status(404).json({ error: 'Sketch not found', notFound: true });
		res.set('Cache-Control', 'public, max-age=60');
		res.json({ name: data.name, files: data.files, user: data.user && { username: data.user.username } });
	} catch (err) {
		res.status(502).json({ error: `Could not reach the p5 editor: ${err.message}` });
	}
});

// Proxy endpoint for the LLM chat backends
app.post('/api/chat', async (req, res) => {
	try {
		const { messages, backend, systemPrompt } = req.body;

		if (!messages || !Array.isArray(messages)) {
			return res.status(400).json({ error: 'Messages array is required' });
		}

		// Optional custom Scene chat prompt from Chat → Prompt (see resolveChatPrompt).
		const resolved = resolveChatPrompt(systemPrompt);
		if (resolved.error) return res.status(400).json({ error: resolved.error });

		const data = await callLLM(resolved.prompt, messages, 16384, backend);

		if (data.error) {
			return res.status(data.status).json({
				error: data.data.error?.message || `API error: ${data.status}`
			});
		}

		res.json(data.data);

	} catch (error) {
		console.error('Proxy error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Error-correction endpoint: takes failing code + error and returns fixed code
app.post('/api/fix-code', async (req, res) => {
	try {
		const { failingCode, errorMessage, errorStack, attempt, priorFixes, backend, sceneContext } = req.body;

		if (!failingCode || !errorMessage) {
			return res.status(400).json({ error: 'failingCode and errorMessage are required' });
		}

		// Build the fix request messages
		let userContent = `The following vr-exec code block failed to execute.\n\n`;
		userContent += `**Error:** \`${errorMessage}\`\n`;
		if (errorStack) {
			userContent += `**Stack:** \`${errorStack}\`\n`;
		}
		userContent += `**Attempt:** ${attempt || 1} of 3\n\n`;
		userContent += `**Failing code:**\n\`\`\`javascript\n${failingCode}\n\`\`\`\n\n`;

		if (priorFixes && priorFixes.length > 0) {
			userContent += `**Previous fix attempts that also failed:**\n`;
			for (const fix of priorFixes) {
				userContent += `\nAttempt ${fix.attempt} error: \`${fix.error}\`\n`;
				userContent += `\`\`\`javascript\n${fix.code}\n\`\`\`\n`;
			}
			userContent += `\nThe prior fixes did not work. Try a different approach.\n`;
		}

		userContent += `\nFix this code. Return ONLY a single \`vr-exec\` code block.`;
		// Editor settings (Environment 2D/3D, Dependencies, gamepad helper)
		// from the client, capped so a bad client can't bloat the request.
		if (typeof sceneContext === 'string' && sceneContext.trim()) {
			userContent += `\n\n${sceneContext.slice(0, 8000)}`;
		}

		const fixMessages = [{ role: 'user', content: userContent }];
		const data = await callLLM(FIX_CODE_PROMPT, fixMessages, 8192, backend);

		if (data.error) {
			return res.status(data.status).json({
				error: data.data.error?.message || `API error: ${data.status}`
			});
		}

		res.json(data.data);

	} catch (error) {
		console.error('Fix-code error:', error);
		res.status(500).json({ error: error.message });
	}
});


// Theme restyle assistant: edits desktop/editor chrome only (not the 3D scene).
const THEME_SYSTEM_PROMPT = `You restyle the Carl Jr / Claude VR desktop editor chrome (#desktop-chat and related overlay UI). You do NOT change the Three.js 3D scene content.

## Goal
When the user asks for a look (colors, fonts, panel feel), return a theme they can apply live.

## Output format (required)
Always include ONE fenced JSON block tagged theme-json:

\`\`\`theme-json
{
  "name": "Short theme name",
  "cssVars": {
    "--dchat-bg": "rgba(22, 22, 32, 0.9)",
    "--dchat-border": "rgba(255,255,255,0.1)",
    "--dchat-text": "#ffffff",
    "--dchat-text-muted": "rgba(255,255,255,0.55)",
    "--dchat-header-bg": "linear-gradient(135deg, rgba(99,102,241,0.45), rgba(139,92,246,0.3))",
    "--dchat-tabs-bg": "rgba(255,255,255,0.03)",
    "--dchat-tab-color": "rgba(255,255,255,0.5)",
    "--dchat-tab-active-bg": "rgba(255,255,255,0.1)",
    "--dchat-tab-active-color": "#ffffff",
    "--dchat-input-bg": "rgba(255,255,255,0.1)",
    "--dchat-accent": "#8b5cf6",
    "--dchat-accent-2": "#6366f1",
    "--dchat-radius": "18px",
    "--dchat-font": "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
  },
  "customCSS": "/* optional extra rules scoped under #desktop-chat */"
}
\`\`\`

## Rules
- Only style editor chrome (chat window, tabs, inputs, buttons). Never invent vr-exec or scene code.
- Prefer cssVars over customCSS. If you use customCSS, scope selectors under #desktop-chat.
- Keep text readable (strong contrast). Do not set opacity so low that UI becomes illegible.
- You may briefly explain the look in plain text outside the fence.
- If the user asks to reset, return cssVars matching a clean dark indigo default.
`;

app.post('/api/theme-chat', async (req, res) => {
	try {
		const { messages, backend } = req.body;
		if (!messages || !Array.isArray(messages)) {
			return res.status(400).json({ error: 'Messages array is required' });
		}
		const data = await callLLM(THEME_SYSTEM_PROMPT, messages, 4096, backend);
		if (data.error) {
			return res.status(data.status).json({
				error: data.data.error?.message || `API error: ${data.status}`
			});
		}
		res.json(data.data);
	} catch (error) {
		console.error('Theme-chat error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Scene save/load endpoints. On Vercel the deployment filesystem is
// read-only except /tmp, and /tmp isn't shared or persistent across
// invocations - save/load will only round-trip within the same warm
// function instance there, not indefinitely like the local server.
const SCENE_FILE = process.env.VERCEL
	? join('/tmp', 'saved-scene.vrscene')
	: join(__dirname, 'saved-scene.vrscene');

app.post('/api/save-scene', (req, res) => {
	try {
		const sceneData = req.body;
		if (!sceneData || !sceneData.codeBlocks || !Array.isArray(sceneData.codeBlocks)) {
			return res.status(400).json({ error: 'Invalid scene data: missing codeBlocks array' });
		}
		fs.writeFileSync(SCENE_FILE, JSON.stringify(sceneData, null, 2), 'utf8');
		res.json({ ok: true, file: 'saved-scene.vrscene' });
	} catch (error) {
		console.error('Save scene error:', error);
		res.status(500).json({ error: error.message });
	}
});

app.get('/api/load-scene', (req, res) => {
	try {
		if (!fs.existsSync(SCENE_FILE)) {
			return res.status(404).json({ error: 'No saved scene found' });
		}
		const data = fs.readFileSync(SCENE_FILE, 'utf8');
		res.json(JSON.parse(data));
	} catch (error) {
		console.error('Load scene error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Community scene sharing, backed by Vercel Blob so uploads are real,
// persistent, and visible to every visitor (not just the uploader's warm
// function instance). Requires a Blob store to be linked to the Vercel
// project, which auto-provides BLOB_READ_WRITE_TOKEN; without it these
// endpoints report a clear error instead of a confusing storage failure.
//
// This talks to Vercel Blob's plain HTTP API directly with fetch, rather
// than the @vercel/blob SDK: that package's "exports" map isn't traced
// correctly by this project's legacy `builds`-based vercel.json config
// (unlike express/cors/selfsigned, which have no "exports" field), so the
// SDK never made it into the deployed function and every call 500'd with
// "Cannot find package '@vercel/blob'".
//
// Pathname shape: community-scenes/{id}--{encodeURIComponent(name)}.json
// The id is stable across renames; the encoded name is only for list
// display without fetching every blob body. Rename rewrites the pathname
// (put + best-effort delete of the old blob) and list dedupes by id.
const COMMUNITY_PREFIX = 'community-scenes/';
const BLOB_API_BASE = 'https://blob.vercel-storage.com';
const SCENE_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

function newSceneId() {
	return Date.now().toString(36) + randomBytes(4).toString('hex');
}

function sanitizeSceneName(name) {
	const cleaned = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
	return (cleaned || 'Untitled').slice(0, 80);
}


// List endpoints avoid fetching blob bodies (name lives in the pathname).
// createdAt/updatedAt still ship for the Community UI:
// - updatedAt ≈ blob uploadedAt (rewrite on rename/upload)
// - createdAt guessed from newSceneId()'s Date.now().toString(36) prefix;
//   falls back to uploadedAt for legacy/unknown ids.
function createdAtGuessFromId(id) {
	if (!id || id.length <= 8) return null;
	const tsPart = id.slice(0, -8);
	const ms = parseInt(tsPart, 36);
	if (!Number.isFinite(ms) || ms < 1e12 || ms > 4e12) return null;
	return new Date(ms).toISOString();
}

function listItemTimestamps(meta) {
	const updatedAt = meta.uploadedAt || null;
	const createdAt = createdAtGuessFromId(meta.id) || updatedAt;
	return { createdAt, updatedAt };
}

function requestOrigin(req) {
	const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
	const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
	return `${proto}://${host}`;
}

function sceneUrls(req, id) {
	const origin = requestOrigin(req);
	return {
		id,
		editorUrl: `${origin}/e/${id}`,
		viewUrl: `${origin}/s/${id}`
	};
}

function communityPathname(id, name) {
	return `${COMMUNITY_PREFIX}${id}--${encodeURIComponent(sanitizeSceneName(name))}.json`;
}

function parseCommunityPathname(pathname) {
	if (!pathname || !pathname.startsWith(COMMUNITY_PREFIX) || !pathname.endsWith('.json')) return null;
	const base = pathname.slice(COMMUNITY_PREFIX.length, -'.json'.length);
	const sep = base.indexOf('--');
	if (sep < 0) {
		// Legacy / id-only pathname
		return { id: base, name: 'Untitled' };
	}
	const id = base.slice(0, sep);
	const encoded = base.slice(sep + 2);
	let name = 'Untitled';
	try { name = decodeURIComponent(encoded) || name; } catch { /* keep default */ }
	return { id, name };
}

function requireBlob(res) {
	if (!process.env.BLOB_READ_WRITE_TOKEN) {
		res.status(501).json({ error: 'Community uploads aren\'t configured on this server (no Blob store linked).' });
		return false;
	}
	return true;
}

async function blobPut(pathname, content, contentType) {
	const res = await fetch(`${BLOB_API_BASE}/${pathname}`, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
			'x-api-version': '7',
			'x-content-type': contentType,
			'x-add-random-suffix': '0'
		},
		body: content
	});
	if (!res.ok) throw new Error(`Blob upload failed: ${res.status} ${await res.text()}`);
	return res.json();
}

async function blobList(prefix) {
	const res = await fetch(`${BLOB_API_BASE}?prefix=${encodeURIComponent(prefix)}`, {
		headers: {
			Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
			'x-api-version': '7'
		}
	});
	if (!res.ok) throw new Error(`Blob list failed: ${res.status} ${await res.text()}`);
	return res.json();
}

async function blobDelete(url) {
	if (!url) return false;
	const res = await fetch(`${BLOB_API_BASE}/delete`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
			'x-api-version': '7',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ urls: [url] })
	});
	if (!res.ok) {
		// Best-effort: older tokens/stores may only accept DELETE ?url=
		const fallback = await fetch(`${BLOB_API_BASE}?url=${encodeURIComponent(url)}`, {
			method: 'DELETE',
			headers: {
				Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
				'x-api-version': '7'
			}
		});
		if (!fallback.ok) {
			console.warn('Blob delete failed:', res.status, await res.text().catch(() => ''), fallback.status);
			return false;
		}
	}
	return true;
}

async function listCommunityBlobs() {
	const { blobs } = await blobList(COMMUNITY_PREFIX);
	const byId = new Map();
	for (const b of blobs || []) {
		const parsed = parseCommunityPathname(b.pathname);
		if (!parsed || !parsed.id) continue;
		const prev = byId.get(parsed.id);
		const uploadedAt = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
		if (!prev || uploadedAt >= prev._uploadedAtMs) {
			byId.set(parsed.id, {
				id: parsed.id,
				name: parsed.name,
				url: b.url,
				pathname: b.pathname,
				uploadedAt: b.uploadedAt,
				size: b.size,
				_uploadedAtMs: uploadedAt
			});
		}
	}
	return [...byId.values()].sort((a, b) => b._uploadedAtMs - a._uploadedAtMs);
}

async function findCommunityBlob(id) {
	if (!SCENE_ID_RE.test(id)) return null;
	const scenes = await listCommunityBlobs();
	return scenes.find(s => s.id === id) || null;
}

async function readCommunitySceneRecord(meta) {
	const res = await fetch(meta.url);
	if (!res.ok) throw new Error(`Failed to fetch scene blob: ${res.status}`);
	const data = await res.json();
	return {
		...data,
		id: data.id || meta.id,
		name: sanitizeSceneName(data.name || meta.name),
		url: meta.url,
		pathname: meta.pathname,
		uploadedAt: meta.uploadedAt
	};
}

// Creation context (chat log + info log, see creationContext.js) rides in
// the upload as `creationContext` = { format, version, encoding, data, summary }.
// It is stored in its own blob so listing/opening a scene stays small, and the
// scene record keeps a stub that points at GET /api/community-scenes/:id/context.
// Vercel caps function request bodies at 4.5 MB; the client keeps the encoded
// context under 3 MB so scene + context fit in one upload.
const CONTEXT_PREFIX = 'community-scene-context/';
const CONTEXT_FORMAT = 'gs-creation-context';
const CONTEXT_MAX_CHARS = 20 * 1024 * 1024;

function validCreationContext(cc) {
	return !!(cc && typeof cc === 'object' && cc.format === CONTEXT_FORMAT &&
		(cc.encoding === 'gzip-base64' ? typeof cc.data === 'string' : cc.encoding === 'json' && cc.data && typeof cc.data === 'object'));
}

function contextStub(cc, id, extra = {}) {
	return {
		format: CONTEXT_FORMAT,
		version: cc.version || 1,
		encoding: cc.encoding,
		stored: 'separate',
		url: `/api/community-scenes/${id}/context`,
		summary: cc.summary && typeof cc.summary === 'object' ? cc.summary : null,
		...extra
	};
}

app.post('/api/community-scenes', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const sceneData = req.body;
		if (!sceneData || !sceneData.codeBlocks || !Array.isArray(sceneData.codeBlocks)) {
			return res.status(400).json({ error: 'Invalid scene data: missing codeBlocks array' });
		}
		const id = newSceneId();
		const name = sanitizeSceneName(sceneData.name);
		const now = new Date().toISOString();
		const { creationContext, ...sceneFields } = sceneData;
		const record = {
			...sceneFields,
			id,
			name,
			createdAt: sceneData.createdAt || now,
			updatedAt: now
		};
		if (creationContext != null) {
			if (!validCreationContext(creationContext)) {
				return res.status(400).json({ error: 'Invalid creationContext' });
			}
			const encoded = JSON.stringify(creationContext);
			if (encoded.length > CONTEXT_MAX_CHARS) {
				return res.status(413).json({ error: 'Creation context is too large' });
			}
			const ctxBlob = await blobPut(`${CONTEXT_PREFIX}${id}.json`, encoded, 'application/json');
			record.creationContext = contextStub(creationContext, id, { blobUrl: ctxBlob.url, size: encoded.length });
		}
		const pathname = communityPathname(id, name);
		const blob = await blobPut(pathname, JSON.stringify(record), 'application/json');
		res.json({
			ok: true,
			url: blob.url,
			pathname: blob.pathname || pathname,
			scene: { id, name, uploadedAt: now, createdAt: record.createdAt, updatedAt: record.updatedAt, size: blob.size },
			...sceneUrls(req, id)
		});
	} catch (error) {
		console.error('Community upload error:', error);
		res.status(500).json({ error: error.message });
	}
});

app.get('/api/community-scenes', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const listed = await listCommunityBlobs();
		const urls = (id) => sceneUrls(req, id);
		const scenes = listed.map(s => ({
			id: s.id,
			name: s.name,
			url: s.url,
			pathname: s.pathname,
			uploadedAt: s.uploadedAt,
			size: s.size,
			...listItemTimestamps(s),
			...urls(s.id)
		}));
		res.json({ scenes });
	} catch (error) {
		console.error('Community list error:', error);
		res.status(500).json({ error: error.message });
	}
});

app.get('/api/community-scenes/:id', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const meta = await findCommunityBlob(req.params.id);
		if (!meta) return res.status(404).json({ error: 'Scene not found' });
		const record = await readCommunitySceneRecord(meta);
		res.json({ ...record, ...sceneUrls(req, meta.id) });
	} catch (error) {
		console.error('Community get error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Lazily loaded creation context for a community scene. Returns the full
// envelope { format, version, encoding, data, summary }. Records uploaded
// before the separate blob existed may still carry it inline.
app.get('/api/community-scenes/:id/context', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const meta = await findCommunityBlob(req.params.id);
		if (!meta) return res.status(404).json({ error: 'Scene not found' });
		const record = await readCommunitySceneRecord(meta);
		const cc = record.creationContext;
		if (!cc) return res.status(404).json({ error: 'This scene has no creation context' });
		if (cc.data) return res.json(cc);
		if (!cc.blobUrl) return res.status(404).json({ error: 'Creation context missing' });
		const ctxRes = await fetch(cc.blobUrl);
		if (!ctxRes.ok) return res.status(502).json({ error: `Failed to fetch creation context: ${ctxRes.status}` });
		res.json(await ctxRes.json());
	} catch (error) {
		console.error('Community context get error:', error);
		res.status(500).json({ error: error.message });
	}
});

app.patch('/api/community-scenes/:id', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const id = req.params.id;
		const meta = await findCommunityBlob(id);
		if (!meta) return res.status(404).json({ error: 'Scene not found' });
		if (req.body == null || req.body.name == null) {
			return res.status(400).json({ error: 'Missing name' });
		}
		const name = sanitizeSceneName(req.body.name);
		const record = await readCommunitySceneRecord(meta);
		record.name = name;
		record.id = id;
		record.updatedAt = new Date().toISOString();
		const newPathname = communityPathname(id, name);
		const blob = await blobPut(newPathname, JSON.stringify(record), 'application/json');
		if (meta.pathname !== newPathname && meta.url) {
			await blobDelete(meta.url);
		}
		res.json({
			ok: true,
			url: blob.url,
			pathname: blob.pathname || newPathname,
			scene: { id, name, uploadedAt: record.updatedAt, createdAt: record.createdAt || null, updatedAt: record.updatedAt, size: blob.size },
			...sceneUrls(req, id)
		});
	} catch (error) {
		console.error('Community rename error:', error);
		res.status(500).json({ error: error.message });
	}
});


// Community themes (editor chrome), same Blob pattern as community-scenes.
const THEME_PREFIX = 'community-themes/';

function themePathname(id, name) {
	return `${THEME_PREFIX}${id}--${encodeURIComponent(sanitizeSceneName(name))}.json`;
}

function parseThemePathname(pathname) {
	if (!pathname || !pathname.startsWith(THEME_PREFIX) || !pathname.endsWith('.json')) return null;
	const base = pathname.slice(THEME_PREFIX.length, -'.json'.length);
	const sep = base.indexOf('--');
	if (sep < 0) return { id: base, name: 'Untitled' };
	const id = base.slice(0, sep);
	const encoded = base.slice(sep + 2);
	let name = 'Untitled';
	try { name = decodeURIComponent(encoded) || name; } catch { /* keep */ }
	return { id, name };
}

async function listThemeBlobs() {
	const { blobs } = await blobList(THEME_PREFIX);
	const byId = new Map();
	for (const b of blobs || []) {
		const parsed = parseThemePathname(b.pathname);
		if (!parsed || !parsed.id) continue;
		const uploadedAt = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
		const prev = byId.get(parsed.id);
		if (!prev || uploadedAt >= prev._uploadedAtMs) {
			byId.set(parsed.id, {
				id: parsed.id,
				name: parsed.name,
				url: b.url,
				pathname: b.pathname,
				uploadedAt: b.uploadedAt,
				size: b.size,
				_uploadedAtMs: uploadedAt
			});
		}
	}
	return [...byId.values()].sort((a, b) => b._uploadedAtMs - a._uploadedAtMs);
}

async function findThemeBlob(id) {
	if (!SCENE_ID_RE.test(id)) return null;
	const themes = await listThemeBlobs();
	return themes.find(t => t.id === id) || null;
}

async function readThemeRecord(meta) {
	const res = await fetch(meta.url);
	if (!res.ok) throw new Error(`Failed to fetch theme blob: ${res.status}`);
	const data = await res.json();
	return {
		...data,
		id: data.id || meta.id,
		name: sanitizeSceneName(data.name || meta.name),
		url: meta.url,
		pathname: meta.pathname,
		uploadedAt: meta.uploadedAt
	};
}

function sanitizeThemePayload(body) {
	const name = sanitizeSceneName(body?.name);
	const cssVars = (body?.cssVars && typeof body.cssVars === 'object' && !Array.isArray(body.cssVars))
		? body.cssVars
		: null;
	if (!cssVars || Object.keys(cssVars).length === 0) {
		return { error: 'Invalid theme: cssVars object required' };
	}
	// Only allow --* keys with string values (no arbitrary injection beyond CSS values).
	const cleaned = {};
	for (const [k, v] of Object.entries(cssVars)) {
		if (typeof k !== 'string' || !k.startsWith('--')) continue;
		if (typeof v !== 'string') continue;
		cleaned[k.slice(0, 64)] = String(v).slice(0, 500);
	}
	if (Object.keys(cleaned).length === 0) {
		return { error: 'Invalid theme: no usable cssVars' };
	}
	let customCSS = '';
	if (typeof body.customCSS === 'string') {
		customCSS = body.customCSS.slice(0, 8000);
	}
	return { name, cssVars: cleaned, customCSS };
}

app.post('/api/community-themes', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const cleaned = sanitizeThemePayload(req.body);
		if (cleaned.error) return res.status(400).json({ error: cleaned.error });
		const id = newSceneId();
		const now = new Date().toISOString();
		const record = {
			id,
			name: cleaned.name,
			cssVars: cleaned.cssVars,
			customCSS: cleaned.customCSS || '',
			createdAt: req.body?.createdAt || now,
			updatedAt: now
		};
		const pathname = themePathname(id, cleaned.name);
		const blob = await blobPut(pathname, JSON.stringify(record), 'application/json');
		res.json({
			ok: true,
			url: blob.url,
			pathname: blob.pathname || pathname,
			theme: { id, name: cleaned.name, uploadedAt: now, createdAt: record.createdAt, updatedAt: record.updatedAt, size: blob.size }
		});
	} catch (error) {
		console.error('Theme upload error:', error);
		res.status(500).json({ error: error.message });
	}
});

app.get('/api/community-themes', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const listed = await listThemeBlobs();
		const themes = listed.map(t => ({
			id: t.id,
			name: t.name,
			url: t.url,
			pathname: t.pathname,
			uploadedAt: t.uploadedAt,
			size: t.size,
			...listItemTimestamps(t)
		}));
		res.json({ themes });
	} catch (error) {
		console.error('Theme list error:', error);
		res.status(500).json({ error: error.message });
	}
});

app.get('/api/community-themes/:id', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const meta = await findThemeBlob(req.params.id);
		if (!meta) return res.status(404).json({ error: 'Theme not found' });
		const record = await readThemeRecord(meta);
		res.json(record);
	} catch (error) {
		console.error('Theme get error:', error);
		res.status(500).json({ error: error.message });
	}
});

app.patch('/api/community-themes/:id', async (req, res) => {
	if (!requireBlob(res)) return;
	try {
		const id = req.params.id;
		const meta = await findThemeBlob(id);
		if (!meta) return res.status(404).json({ error: 'Theme not found' });
		if (req.body == null || req.body.name == null) {
			return res.status(400).json({ error: 'Missing name' });
		}
		const name = sanitizeSceneName(req.body.name);
		const record = await readThemeRecord(meta);
		record.name = name;
		record.id = id;
		record.updatedAt = new Date().toISOString();
		const newPathname = themePathname(id, name);
		const blob = await blobPut(newPathname, JSON.stringify(record), 'application/json');
		if (meta.pathname !== newPathname && meta.url) {
			await blobDelete(meta.url);
		}
		res.json({
			ok: true,
			url: blob.url,
			pathname: blob.pathname || newPathname,
			theme: { id, name, uploadedAt: record.updatedAt, createdAt: record.createdAt || null, updatedAt: record.updatedAt, size: blob.size }
		});
	} catch (error) {
		console.error('Theme rename error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Pretty share URLs: /s/:id is display-only, /e/:id opens the editor with that scene.
// <base href="/"> in index.html keeps ./main.js and vendor_modules resolving from root.
function sendAppIndex(_req, res) {
	res.sendFile(join(__dirname, 'index.html'));
}
app.get('/s/:id', sendAppIndex);
app.get('/e/:id', sendAppIndex);

// Get local network IP for Quest 3 connection
function getLocalIP() {
	const nets = networkInterfaces();
	for (const name of Object.keys(nets)) {
		for (const net of nets[name]) {
			if (net.family === 'IPv4' && !net.internal) {
				return net.address;
			}
		}
	}
	return 'localhost';
}

// Generate (and cache to disk) a self-signed cert covering localhost + the
// current LAN IP, so a WebXR-capable HTTPS origin is available for the
// Quest browser without needing a real certificate. Re-generated whenever
// the cached cert doesn't cover the machine's current LAN IP (e.g. it
// changed networks) or is missing.
async function getOrCreateCert(localIP) {
	const certDir = join(__dirname, 'certs');
	const keyPath = join(certDir, 'key.pem');
	const certPath = join(certDir, 'cert.pem');
	const metaPath = join(certDir, 'meta.json');

	if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
		try {
			const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
			if (meta.localIP === localIP) {
				return {
					key: fs.readFileSync(keyPath, 'utf8'),
					cert: fs.readFileSync(certPath, 'utf8'),
				};
			}
		} catch {
			// fall through to regenerate
		}
	}

	console.log('\x1b[36mGenerating self-signed HTTPS certificate...\x1b[0m');
	const attrs = [{ name: 'commonName', value: localIP }];
	const notAfterDate = new Date();
	notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
	const pems = await selfsigned.generate(attrs, {
		notAfterDate,
		algorithm: 'sha256',
		keySize: 2048,
		extensions: [
			{
				name: 'subjectAltName',
				altNames: [
					{ type: 2, value: 'localhost' },   // DNS
					{ type: 7, ip: '127.0.0.1' },       // IP
					{ type: 7, ip: localIP },           // IP
				],
			},
		],
	});

	fs.mkdirSync(certDir, { recursive: true });
	fs.writeFileSync(keyPath, pems.private);
	fs.writeFileSync(certPath, pems.cert);
	fs.writeFileSync(metaPath, JSON.stringify({ localIP }));

	return { key: pems.private, cert: pems.cert };
}

// On Vercel, the platform already terminates TLS with a real (non-self-signed)
// certificate and invokes this file as a request handler directly - there's no
// self-signed cert to generate and nothing to .listen() on. Only do the local
// HTTPS-server dance when actually running via `node server.js` / run.py.
if (!process.env.VERCEL) {
	const localIP = getLocalIP();

	const { key, cert } = await getOrCreateCert(localIP);
	const server = https.createServer({ key, cert }, app);

	server.listen(PORT, '0.0.0.0', () => {
		console.log('\n\x1b[32m=== Claude VR Chat Server ===\x1b[0m\n');
		console.log(`Local:   https://localhost:${PORT}`);
		console.log(`Network: https://${localIP}:${PORT}`);
		console.log('\n\x1b[36mOpen the Network URL on your Quest 3 browser.\x1b[0m');
		console.log('\x1b[33mNote: Both devices must be on the same WiFi network.\x1b[0m');
		console.log('\x1b[33mSelf-signed certificate: the browser will warn on first');
		console.log('visit — accept/proceed once to continue ("Advanced" > "Proceed").\x1b[0m');
		console.log();
	});
}

export default app;
