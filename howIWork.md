# How GS Works

An overview of the program: what it is, how the pieces fit together, and how a
request flows from your voice/keyboard through Claude and back into the 3D scene.

## What it is

GS is a **WebXR (Meta Quest) app that lets you talk to Claude
inside VR and have Claude modify the 3D scene live**. You type or speak a
request; Claude replies in a floating chat panel and can emit code that runs
immediately in the scene (spawning objects, animating them, injecting UI).

Three moving parts:

1. **`run.py`** — a Python launcher that starts/stops the web server and injects
   your Claude API key.
2. **`site-source/server.js`** — a small Node/Express server that serves the app
   and proxies requests to the Anthropic API (so the key never reaches the
   browser).
3. **`site-source/index.html` + `main.js`** — the browser-side WebXR app
   (Three.js) that renders the scene, panels, and handles all input.

```
  you ── run.py ──► node server.js ──► serves the web app to the Quest browser
                         │
                         └── /api/chat, /api/fix-code ──► api.anthropic.com
                                                          (Claude)
  Quest browser (index.html + main.js, Three.js WebXR)
      ▲  renders scene · panels · HUD · handles controllers/mic
      └── talks only to the local server, never directly to Anthropic
```

## File map

| Path | Role |
| --- | --- |
| `run.py` | Launcher: `start`/`stop`/`status`/`restart`, API-key resolution, streams server output. |
| `site-source/server.js` | Express server: static hosting + `/api/chat`, `/api/fix-code`, `/api/save-scene`, `/api/load-scene`. Holds the system prompts. |
| `site-source/index.html` | DOM shell + styles: chat overlay (input/MIC/Send), status pill, `#ui-toggle`, export modal, and the WebXR `overlay-root`. |
| `site-source/main.js` | The whole client app: scene setup, panels, input, speech, locomotion, and the vr-exec execution engine. |
| `site-source/chatPrompt.js` | Chat → Prompt: the editable Scene chat prompt. Loads the default from `/api/prompts`, keeps a saved edit in `localStorage` (`gs.customChatPrompt.v1`) and adds it to `/api/chat` requests as `systemPrompt` (Scene chat and community merges; Ollama gets it directly). Shows the required technical section and the read-only fix-code / theme prompts. |
| `site-source/exporter.js` | Share tab + 3D export: collects user content (plus the scene code's directional/point/spot lights; not GS's default rig, ambient or hemisphere), GLB and self-contained .gltf (GLTFExporter, KHR_lights_punctual), binary FBX 7.4 writer, OBJ+MTL+textures .zip, Blender .zip (.glb + `open_in_blender.py`), the export dialog and the Share tab content. Share link reuses main.js `shareCurrentScene()` → the Community share modal / upload flow. VR: Scenes panel shortcuts (Share link, Save GLB/glTF/FBX/OBJ/Blender) download directly / copy the link. |
| `site-source/threejsAddons/ARButton.js` | Enter-session button; requests the immersive WebXR session with `local-floor` + `dom-overlay`. |
| `site-source/node_modules/three` | Three.js (loaded via the import map in `index.html`). |

## Startup & configuration

- **Launch:** `python run.py --api-key sk-ant-...` (or `--api-key-file`, or the
  `CLAUDE_API_KEY` env var, or an interactive hidden prompt). The launcher passes
  the key to the Node child **only** via its environment; it's never written to
  disk or logged. `run.py restart` stops then starts.
- **Server:** `server.js` reads `CLAUDE_API_KEY` from the environment (exits if
  missing), serves `site-source/` statically, and prints a `Local:` and
  `Network:` URL. Open the **Network URL** in the Quest browser (both devices on
  the same Wi-Fi). `PORT` defaults to 3000.

## The AI loop (chat → code → scene)

1. You send a message (typed, spoken, or via the in-scene keyboard). `sendMessage`
   in `main.js` sets the loading state, shows **"Claude is thinking..."**, and
   POSTs the conversation to `/api/chat`.
2. `server.js` forwards it to Anthropic with the **`claude-sonnet-5`** model and a
   system prompt (`SYSTEM_PROMPT`) that teaches Claude the scene's globals and
   coordinate system. The key stays server-side.
   If you edited the prompt in **Chat → Prompt**, the request carries it as
   `systemPrompt` (max 40,000 characters); the server uses it instead of
   `SYSTEM_PROMPT` and always appends `CHAT_PROMPT_REQUIRED`, a short
   non-editable section (vr-exec blocks, globals, floor / facing, editor
   settings note) so scene code keeps running. Reset to default deletes the
   edit. The default prompt includes a photorealistic lighting and materials
   section (one motivated shadow-casting key light, weak fill and ambient,
   RoomEnvironment reflections, ACES tone mapping, physical intensities, PBR
   material values, colour spaces, VR limits). GS's own default lights are named
   `gsDefaultAmbient` and `gsDefaultKey` so scene code can dim them.
3. Claude's reply is shown in the chat panel. Any fenced ` ```vr-exec ` code
   blocks are extracted (`parseVrExecBlocks`) and executed in order.
4. **Execution** (`executeVrCode`): the code runs inside an `AsyncFunction` with
   these injected globals — `THREE`, `scene`, `camera`, `renderer`, `document`,
   `hud`. So `scene.add(obj)` drops objects into the world.
5. **Auto-fix:** if a block throws, the app sends the failing code + error to
   `/api/fix-code` (a second Claude call with `FIX_CODE_PROMPT`) and retries up to
   3 times, reporting the outcome in chat.

### Environment, Dependencies & game controllers

- **Dependencies tab** lists THREE.js r180 (built in), **ammo.js** (on by
  default) and **p5.js 1.11.13** (off by default). The loader is a classic
  `<script>` in `index.html` that runs before `main.js` and injects a script
  tag for each library that is on (choices saved in `localStorage`
  `gs.dependencies`). ammo.js comes from the vendored
  `vendor_modules/three/examples/jsm/libs/ammo.wasm.js` with a jsDelivr
  fallback; p5.js from jsDelivr with an unpkg fallback.
- Scene code gets libraries with `await gsRequire('ammo' | 'p5' | 'three')`
  (ammo.js is initialised once and cached), so saved scenes still work if a
  library is switched off.
- **Environment → 2D / 3D** (`gs.sceneEnvironment`): 2D → p5.js or blank
  canvas, 3D → THREE.js (default) or raw WebGL. 2D/WebGL content goes on an
  in-scene panel via `gsCreateCanvasSurface()` / `gsCreateP5Surface()`, so it
  also shows in a headset.
- Every `/api/chat` request adds a short "[GS editor settings]" note to the
  newest user message (only on the copy that is sent), with the environment,
  which dependencies are on, the ammo.js physics recipe and the `gsGamepad`
  API. `/api/fix-code` sends the same note as `sceneContext`. This works on
  hosts whose system prompt has not been updated yet.
- **Phones** (`html.gs-phone`: touch screen, short side <= 600px; set in
  main.js): 44px tap targets, one scrollable tab row, attach / files / mic /
  history behind a "+" button, landscape panel on the left with the dock on
  the right. While the on-screen keyboard is up (`html.gs-kb` / `gs-kb-chat`,
  detected from `visualViewport`), the panel fills the area above the keyboard
  with just the messages (or Code editor) and the input row; the dock, tabs,
  Hide UI and joysticks hide, and the canvas is not resized. Desktop and VR
  are unaffected. Test: `test-harness/mobile-layout`.
- **Desktop camera controls** (`site-source/cameraControls.js`): the stock
  three.js r180 addons from `vendor_modules/three/examples/jsm/controls/`:
  Orbit (OrbitControls, default, target at the origin), Map (MapControls),
  Trackball, Fly (FlyControls), First person (PointerLockControls + WASD as in
  the three.js pointerlock example) and Off, picked in the Controls tab. Only
  focused text fields block keys; VR uses head tracking. Scenes see
  `window.gsControls` / `window.controls` / `window.gsOrbit`.
- **Game controllers** (Gamepad API, `window.gsGamepad`): Xbox Series X|S
  and other standard pads over USB or Bluetooth drive the desktop/phone
  camera through the stock three.js control picked in the Controls tab
  (Orbit / Map: right stick orbits, left stick pans / dollies, LT/RT zoom;
  First person: left stick walks, right stick looks; Fly: left stick moves,
  right stick yaw/pitch, LB/RB down/up; Trackball and Off: not used; Y
  toggles Orbit / First person, View resets). Scenes read the pad with `gsGamepad.axis()`,
  `button()`, `justPressed()`, `onButton()`, and set
  `gsGamepad.captureCamera = true` to take the sticks over. WebXR headset
  controllers are separate (XR `inputSources`).

### Anchoring rules (important)

- Objects added via `scene.add(...)` are anchored to the **room/world**, not the
  UI — they stay put as you move. This is the default the system prompt enforces.
- `hud` is a group attached to the camera (head-locked). Claude only uses it when
  you explicitly ask for a follow-me/HUD element.
- A safety net (`reanchorStrayObjects`) runs after every block: anything
  accidentally parented to the camera or a UI panel is re-parented back into the
  world (world transform preserved), except intentional `hud` content.

## The WebXR front-end (`main.js`)

### Scene graph

```
scene
├── lights, vrSkybox
├── player (rig / "dolly")            ← moves for locomotion
│   ├── camera
│   │   └── hud                        ← head-locked
│   │       ├── hudStatusPanel         ← "Transcribing…" etc. badge
│   │       └── uiTogglePanel          ← Hide/Show-UI button
│   └── controller 0 / controller 1    ← with ray lines
├── chatPanel   (Claude's replies)
├── inputPanel  ([text][MIC][KEYS][Send])
├── keyboardPanel (in-scene QWERTY)
├── sidePanel   (session/mode toggle + color/brightness)
├── scenePanel  (saved-scene manager)
└── reticles (cursor rings)
```

All panels are **canvas-texture planes**: each draws to a 2D `<canvas>`, wrapped
in a `THREE.CanvasTexture` that's flagged `needsUpdate` when its content changes.
Panels **billboard** (face the camera) each frame but stay at fixed world
positions. `positionAllPanels()` lays them out around eye level.

### Input & interaction

- **Raycasting:** each controller casts a ray; a **reticle** ring shows the hit
  point and changes color by target. `onXRSelectStart` (trigger) dispatches a
  click to whatever panel/button was hit; the render loop builds the hit-target
  list each frame and drives the reticle + hover highlight.
- **Controller buttons:**

  | Input | Action |
  | --- | --- |
  | Trigger | Select / press panels, keys, buttons |
  | A / X (hold) | Push-to-talk voice |
  | B / Y | Toggle pointer ray *lines* (cursor stays) |
  | Thumbstick press | Collapse / restore all UI |
  | Right grip | Cycle locomotion mode (off → planar → free-roam) |
  | Left thumbstick | Move (when locomotion on) / scroll scene list (when off) |
  | Right thumbstick | Turn (when locomotion on) / scroll chat (when off) |

### Locomotion

The camera + controllers live in a `player` rig. Moving/rotating that group is the
WebXR-correct way to move the user (three.js composes the rig transform with the
live headset pose). Modes cycle with the right grip button:

- **off** — thumbsticks scroll the chat / scene list (original behavior).
- **planar** — left stick moves on the horizontal plane (in/out + strafe) relative
  to where you look; no vertical.
- **free** — left stick flies in the full look direction, including up/down.

Right stick turns (yaw), pivoting around your head so the view doesn't swing.
Speeds are the `MOVE_SPEED` / `TURN_SPEED` constants.

### Text & voice input

- **In-scene keyboard** (`keyboardPanel`): a QWERTY canvas keyboard driven by the
  controller ray — used instead of the Quest system keyboard, which crashes the
  browser inside an immersive session. Collapsible via the **KEYS** button.
- **Speech-to-text** (cross-platform, no API key): audio is captured with
  `getUserMedia` + `MediaRecorder` and transcribed **locally in the browser** by
  Whisper via transformers.js (loaded on demand from a CDN, cached after first
  use). Two modes:
  - **Always-on** (MIC button): a voice-activity detector segments speech and
    auto-sends each finished utterance.
  - **Push-to-talk** (A/X button): records while held, sends on release.
  The VAD is pumped from the XR animation loop (not `requestAnimationFrame`, which
  pauses during immersive sessions).

### HUD & UI management

- **Status badge** (`hudStatusPanel`): a small head-locked notification in the
  lower-right periphery that mirrors the DOM status pill ("Transcribing…",
  "Sending…", errors), shown only for active states.
- **Collapse all UI**: the head-locked **Hide/Show-UI** button, the DOM `#ui-toggle`
  button (windowed), or thumbstick-press hide every main panel for an
  unobstructed scene; the toggle and status badge always stay reachable.

## Scenes & persistence

- vr-exec code blocks from the session are remembered (`executedCodeBlocks`) so the
  scene can be rebuilt.
- **Save/Load/Export:** `/api/save-scene` and `/api/load-scene` persist a scene as
  a `.vrscene` (JSON of code blocks). The scene manager panel lists imported
  scenes, toggles them active, and rebuilds the scene from the active set.
- `snapshotSystemObjects()` records the app's own objects at startup so
  `clearUserObjects()` can wipe only user/generated content.

## Rendering loop

`renderer.setAnimationLoop` runs every frame (in both windowed and immersive
modes) and: computes frame `dt`, pumps the mic VAD, billboards panels, updates
reticles/hover, polls controller buttons, applies locomotion or scrolling, runs
any user animation callbacks in `window._vrAnimations`, and renders the scene.

## Platform gotchas (Meta Quest)

- **Secure context required:** WebXR *and* the microphone need HTTPS (or
  localhost). If XR runs, the mic generally can too.
- **`dom-overlay` is unreliable on Quest 3**, so critical feedback is mirrored into
  the 3D scene (input panel text, chat panel, head-locked status badge) rather
  than relying on DOM elements being visible in-headset.
- **The system keyboard crashes immersive sessions** — hence the in-scene keyboard.
- **`window.requestAnimationFrame` is paused during immersive sessions** — anything
  frame-driven (VAD, locomotion) runs from `renderer.setAnimationLoop` instead.
- **Head-locked content** (`hud` children) relies on camera-child rendering; the
  thumbstick/DOM fallbacks exist in case a given headset renders it oddly.

## Key knobs (constants in `main.js` / model in `server.js`)

- Panel sizes/gaps: `*_PANEL_WIDTH/HEIGHT/GAP`.
- Movement: `MOVE_SPEED`, `TURN_SPEED`; scrolling: `SCROLL_SPEED`,
  `THUMBSTICK_DEADZONE`.
- Speech: `STT_MODEL` (`Xenova/whisper-tiny.en`), `STT_CDN`, `VAD_RMS_THRESHOLD`,
  `VAD_SILENCE_MS`.
- Model: `model: 'claude-sonnet-5'` in `server.js` (`callClaudeAPI`).
