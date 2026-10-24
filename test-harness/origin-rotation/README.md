# Origin rotation headless test

Checks the Environment tab's **Origin rotation** item (`site-source/originGizmo.js`
plus the `gsOriginRoot` wiring in `main.js`) in Chrome via puppeteer-core, with
an IWER-emulated Meta Quest 3 for the VR part.

`npm install`, then serve the site with the Vercel simulator (needed for the
share-link round trip; it needs the repo root's `npm ci`):

    cd ../creation-context && SIM_PORT=3842 node vercel-sim.mjs &
    cd ../origin-rotation && BASE=http://localhost:3842 node test.mjs
    ONLY=desktop|phone|physics|share|vr node test.mjs     # one section
    SHOT_DIR=/some/dir node test.mjs                       # screenshots (default /workspace/gs-origin-shots)

What it checks:

- **desktop (1280x860, mouse) and phone (390x844, CDP touch, `html.gs-phone`)**:
  the gizmo shows with six labelled axis ends; starts unrotated with content on
  the scene root; dragging the ball (real `Input.dispatchMouseEvent` /
  `Input.dispatchTouchEvent`) rotates, adopts content into `gsOriginRoot` with
  its local transform kept, and updates the readout and fields; the ring rolls;
  Shift-drag (desktop) and the Snap 15° toggle snap to 15° (typed values too);
  typed yaw/pitch/roll (pitch clamped to ±90, roll wrapped to ±180, junk
  ignored); clicking/tapping an axis end (filled +, hollow −) turns that axis
  toward the viewer, squared to 90°; Reset origin; persistence across reload;
  content added after a reload is adopted; `scene.remove` on adopted objects;
  Orbit target stays at the origin and orbit drag still orbits (desktop); GLB
  export bakes the rotation in (and is back in scene coordinates after Reset);
  the AI settings note mentions the rotation only while rotated; 44px tap
  targets on the phone; no console errors.
- **physics**: an ammo.js body falls along the scene's own −Y under roll 90°,
  shown at the rotated spot; `gsOrigin.toLocal` round-trips; a Code-tab hot
  reload keeps the falling body where it was.
- **share**: the uploaded scene carries `originRotation`; an unchanged scene
  reuses the link, a rotation-only change uploads a new one; `/e/:id` in a fresh
  browser restores the rotation; a scene without the field (pre-0.98) opens
  unrotated even when the browser had a rotation saved.
- **vr**: in the HTML-in-canvas VR menu (switched on with the ray), a
  controller-ray drag on the gizmo rotates, a trigger on Reset origin resets,
  the player rig and menus are not rotated.
