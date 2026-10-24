# Community scene merge – headless tests

Tests for `site-source/communityMerge.js` (🔀 Merge scenes in the Community tab).

* `unit.mjs` – pure functions: literal tokenizer, asset classification, request building
  (no base64 in the prompt), `@gs-keep` / token expansion, unknown-token errors.
  `node unit.mjs`
* `vercel-sim.mjs` – runs `site-source/server.js` with `VERCEL=1` against an in-memory fake
  Vercel Blob API (port `PORT`, default 3701). `node vercel-sim.mjs`
* `test.mjs` – puppeteer-core + headless Chrome (swiftshader), desktop and phone viewports.
  `/api/chat`, `/api/fix-code` and `/api/backends` are intercepted with a simulated AI, so no
  real tokens are used. It seeds two Community scenes (A with a creation-context envelope, B with
  a p5 sketch PNG and a data-URL texture), picks them via row buttons and the search picker,
  checks the outgoing payload (asset placeholders, no base64), byte-exact substitution, keep markers,
  auto-fix on tokenized code, new-scene load, originals untouched, parents and prompt in the
  creation context, credits on publish, reopen, error paths and no console errors.
  `BASE=http://localhost:3701 node test.mjs` (`HOT=1` for the gs.state / gsImportP5Sketch variant;
  `CUSTOM_PROMPT=1` saves a custom Scene chat prompt first and checks the merge request carries it).
* `real-sanity.mjs` – ONE real merge call to the live site's `/api/chat` with two tiny scenes
  (claude-haiku-55). Only runs with `GS_REAL_CALL=1`; costs a real API call.

Needs `puppeteer-core` resolvable (e.g. `npm i puppeteer-core` here) and `/usr/bin/google-chrome`.
