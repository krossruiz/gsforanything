# VR windows: one html-in-canvas path + contrast

Every VR window (the menu, the in-scene keyboard, the head-locked Hide/Show UI
button) is a DOM element painted by `htmlInCanvas.js` and shown by
`vrWindows.js`. `test.mjs` runs an IWER-emulated Meta Quest 3 session and checks:

- Only the three `vrWindow:*` meshes render UI on the menu layer (no legacy
  canvas panels); each one is a `CanvasTexture` of its painted DOM source, sized
  with the same CSS px → angular scale.
- Contrast: `contrast-audit.js` (computed styles, alpha-composited over the
  opaque window) — text ≥ 4.5:1, UI boundaries and the selected-tab indicator
  ≥ 3:1, amber ray-hover ring present — **and** pixel samples of the painted
  textures (so a painter bug cannot hide behind correct CSS).
- Real controller rays (IWER pose + trigger/thumbstick/grip): hover ring on the
  menu, keyboard and HUD; click switches tabs; Fixed/Follow by ray (Follow swings
  the menu after a head turn, Fixed keeps it); trigger-drag and thumbstick
  (locomotion off via right grip) scroll the chat log; clicking the chat input
  opens the keyboard with a focus ring, key clicks type, Done closes it; the HUD
  button hides/shows the menu; leaving VR hides every window.
- "Lay down" is gone: no menu option, no code, a stored lay-down key is removed
  on load and the view is upright.
- No console errors.

Other scripts:

- `perf.mjs` — menu repaint stays throttled (≤ ~15/s) while the Code tab
  scrolls every frame.
- `audit-run.mjs` — prints the contrast audit for any build
  (`OPAQUE=1` for builds that paint windows opaque; `JSON=out.json` to save).
- `shots.mjs` — stereo screenshots in VR plus each window's texture
  (`PREFIX=after OUT=/some/dir`).

```bash
npm i            # iwer + puppeteer-core
BASE=https://localhost:3488 node test.mjs   # any GS server; needs /usr/bin/google-chrome
BASE=https://localhost:3488 node perf.mjs
```
