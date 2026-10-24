# GS Cloudflare Worker (`gs`)

Source of https://gsforanything.com (and www.gsforanything.com; fallback
https://gs.krossruiz.workers.dev). The browser app is the same as on
Vercel (`site-source/`); this Worker serves it as static assets and implements
the `server.js` API on Cloudflare:

| Route | What |
| --- | --- |
| `POST /api/chat`, `/api/fix-code`, `/api/theme-chat` | LLM proxy (Claude / OpenAI), prompts from `prompts.js` |
| `GET /api/backends` | available models (depends on which secrets are set) |
| `/api/community-scenes` (+ `/:id`, `/:id/context`) | Community scenes in KV `SCENES`; creation context stored under `scene:<id>:context` |
| `/api/community-themes`, `/api/save-scene`, `/api/load-scene`, `/api/prompts` | themes, private saves (KV), prompts |
| `GET /api/p5-editor/:user/:id` | relay for p5 web editor projects (only `editor.p5js.org`; same validation as `server.js`) |
| `/s/*`, `/e/*` | share / embed links |

Files:

- `index.js`: the Worker.
- `prompts.js`: **generated**: `node gen-prompts.mjs` extracts the prompts (`SYSTEM_PROMPT`, `FIX_CODE_PROMPT`, `THEME_SYSTEM_PROMPT`, `CHAT_PROMPT_REQUIRED`) and `MAX_CUSTOM_PROMPT_CHARS` from `../site-source/server.js`. `/api/chat` honours a custom `systemPrompt` (Chat → Prompt) the same way server.js does.
- `wrangler.jsonc`: Worker name, assets (`./public`, `run_worker_first` for `/api/*`, `/s/*`, `/e/*`), `SCENES` KV binding.
- `sync-public.sh`: rebuilds `public/` (gitignored) from `../site-source` (client files only).

No secrets live here. `CLAUDE_API_KEY`, `OPENAI_API_KEY`, `LLM_BACKEND` and
`OPENAI_MODEL` are Worker secrets (`wrangler secret put …`) and persist across
deploys. The KV namespace id is not a secret.

Deploy (Node ≥ 22, wrangler 4, logged in):

```bash
cd worker
./sync-public.sh
node gen-prompts.mjs
npx wrangler deploy
```

Local test: `npx wrangler dev --local --port 8787 --local-upstream 127.0.0.1:8787 --persist-to /tmp/gs-kv` (needs secrets in `.dev.vars` for chat; everything else works without them). Keep `--local-upstream`: with the custom-domain `routes` in `wrangler.jsonc`, `wrangler dev` otherwise presents requests as `gsforanything.com`, so share links made locally point at the live site.
