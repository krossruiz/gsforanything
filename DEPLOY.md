# Deploying GS

Agents: **read this file before every deploy.** Do not invent a version number.

## Version number (required)

1. **Ask the user for the version number** before deploying. Never guess or auto-bump.
2. Set it in **one place**: `site-source/version.js` → `export const GS_VERSION = '…'`.
3. Keep `site-source/versions.json` in sync for the picker (at least the current id/label). Add older/preview entries later with `{ id, label, url }`.
4. Commit the version bump with the release (or with the feature being shipped).

Current shipped version at time of writing this doc workflow: see `GS_VERSION` in `version.js` (e.g. `0.967`).

## Where the code lives

| Surface | Path / notes |
|--------|----------------|
| PC repo | `C:\Users\KROSS\Desktop\programming projects\carljr\carljr` (machine `Kross_G16`) |
| GitHub | `koshkakochka/gsforanything` (https://github.com/koshkakochka/gsforanything; owner renamed from `krossruiz`, repo renamed from `gs`, earlier `carljr`; the old URLs redirect); push `origin/main` |
| Vercel prod | https://vrclaudeinterface.vercel.app |
| Cloudflare Worker | Worker name **`gs`** → https://gsforanything.com (also https://www.gsforanything.com; fallback https://gs.krossruiz.workers.dev). Custom domains are set in `worker/wrangler.jsonc` `routes`; keep `workers_dev: true` |
| Unrelated | **https://gs.vercel.app is not this project** — ignore it |

Local HTTPS test serve (box): often `/workspace/gs-serve-gh` on `https://localhost:3456` (self-signed). Prefer PC edits; sync client files into the serve copy for browser tests.

## Vercel

1. Ask user for version → update `version.js` + `versions.json`.
2. Ensure `vercel.json` `includeFiles` lists every client module the browser imports (`main.js`, `syntaxHighlight.js`, `version.js`, `versions.json`, `htmlInCanvas.js`, `menuSystem.js`, `vrWindows.js`, `exporter.js`, `creationContext.js`, `p5Import.js`, `communityMerge.js`, `twinSticks.js`, `cameraControls.js`, `threejsAddons/**`, `vendor_modules/**`, etc.).
3. Commit only the intended files; push `origin/main`.
4. **GitHub auto-deploy** usually ships Production for `vrclaudeinterface` / `carljr`. If the PC is online and logged into Vercel CLI: `npx vercel --prod --yes` from the repo root.
5. Verify (below).

## Cloudflare Workers (`gs`)

Since 0.973 the Worker source lives in this repo under **`worker/`** (see `worker/README.md`):
`index.js` (API: chat, backends, community scenes + creation context, p5 editor relay, `/s/*`, `/e/*`),
`prompts.js` (generated from `site-source/server.js`), `wrangler.jsonc` (name `gs`, `SCENES` KV binding,
assets), `gen-prompts.mjs` and `sync-public.sh`. **No secrets are in the repo**; `CLAUDE_API_KEY`,
`OPENAI_API_KEY`, `LLM_BACKEND`, `OPENAI_MODEL` are Worker secrets in Cloudflare and survive deploys.

Wrangler is typically authenticated on the **box**, not always on the PC.

1. Ask user for version → same `version.js` / `versions.json` as Vercel (from `origin/main`).
2. `cd worker && ./sync-public.sh` — copies **all** browser assets into `worker/public/` (gitignored):
   - `index.html`, `main.js`, `version.js`, `versions.json`, `syntaxHighlight.js`, `htmlInCanvas.js`, `vrWindows.js`, `p5Import.js`, `menuSystem.js`, `exporter.js`, `creationContext.js`, `communityMerge.js`, `twinSticks.js`, `cameraControls.js`
   - `threejsAddons/`
   - **full `vendor_modules/`** — especially `vendor_modules/three/build/three.module.js` (the script fails if it is missing)
   - Add any new browser file to `sync-public.sh` **and** `vercel.json` `includeFiles`.
3. **Prior bug:** if `public/vendor_modules/three/build/` is missing, `/` and `/main.js` still return 200 but the import map 404s `three.module.js`, so the app never boots (blank canvas, empty Model dropdown, no welcome). Always restore `three/build` from git if the working tree deleted it, then sync again.
4. `node gen-prompts.mjs` — regenerates `prompts.js` whenever the prompts in `server.js` change.
5. Server API changes in `server.js` must be ported to `worker/index.js` by hand (same validation). `worker-patches/0001` is already applied there (kept for history).
6. `wrangler.jsonc`: keep **`SCENES` KV** binding; **do not touch secrets**.
7. Deploy from `worker/`: `npx wrangler deploy` (Node ≥ 22). Writable cache if needed (`XDG_CACHE_HOME` under the project).
8. Verify (below).

## Post-deploy verification (both hosts)

```bash
# Must be 200 with a large body (~600KB)
curl -sL -o /dev/null -w "%{http_code} %{size_download}\n" \
  https://HOST/vendor_modules/three/build/three.module.js

curl -sL -o /dev/null -w "%{http_code} %{size_download}\n" https://HOST/main.js
curl -sL -o /dev/null -w "%{http_code} %{size_download}\n" https://HOST/version.js
curl -sL -o /dev/null -w "%{http_code} %{size_download}\n" https://HOST/versions.json
```

Replace `HOST` with `vrclaudeinterface.vercel.app`, `gsforanything.com`, `www.gsforanything.com` and `gs.krossruiz.workers.dev` (fallback).

In the browser: canvas appears, Model dropdown populates, welcome message shows, bottom version control shows the number you set, version picker opens.

## Version log (after each ship)

Follow **`version-log/Version Log Updating Rules.md`** (exact verbatim chat only).

1. Ensure `GS_VERSION` matches the shipped number (ask the user; never invent).
2. Archive **exact** user messages and assistant SendToUser replies into `version-log/<version>/conversation.md` (or `thread-*.md`) using:

   ```markdown
   ### User
   ...
   ### Assistant
   ...
   ```

3. Do **not** store paraphrased NOTES, topic lists, system prompts, tool dumps, or secrets.
4. See also `version-log/README.md` if present.


## Checklist (agents)

- [ ] Asked user for version; set `GS_VERSION` + `versions.json`
- [ ] Read this file before deploy
- [ ] Vercel: push and/or `vercel --prod`; includeFiles complete
- [ ] CF: full `public/` sync including **`vendor_modules/three/build/`**
- [ ] CF: SCENES KV kept; secrets untouched
- [ ] Both hosts: `three.module.js` 200; smoke-test canvas
- [ ] Updated `version-log/<version>/` with exact conversation transcript (see Version Log Updating Rules.md)
