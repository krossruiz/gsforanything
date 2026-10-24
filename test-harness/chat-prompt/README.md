# Chat → Prompt (editable Scene chat prompt)

`npm install` (puppeteer-core; Chrome at `/usr/bin/google-chrome`), serve
`site-source` with fake keys (`CLAUDE_API_KEY=fake OPENAI_API_KEY=fake PORT=3488 node server.js`), then:

    BASE=https://localhost:3488 node test.mjs        # browser: desktop, phone + keyboard, headset panel
    BASE=http://127.0.0.1:3602 node test.mjs         # same against wrangler dev (the Worker)
    node upstream.mjs                                # server.js + Worker: what reaches the LLM call
    WORKER_BASE=http://127.0.0.1:3602 node upstream.mjs   # also check a running wrangler dev

No real API calls: `test.mjs` intercepts `/api/chat` in the browser and blocks
Community POSTs; `upstream.mjs` runs `server.js` with `mock-llm-https.mjs`
preloaded (answers api.anthropic.com / api.openai.com locally and records the
request bodies) and runs `worker/index.js` in Node with a mocked `fetch`.

`test.mjs` checks (screenshots in `SHOT_DIR`, default `/workspace/gs-prompt-shots`):

- Chat has Scene | Theme | Prompt subtabs; the nine top tabs are unchanged.
- The Prompt view shows the full default prompt from `/api/prompts` (with the
  photorealistic lighting and materials section), the "Default prompt" badge, the
  character count, the required technical section and the read-only auto-fix and
  theme prompts.
- Typing marks unsaved changes; Discard restores; Ctrl+S / Save stores it in
  localStorage; the "Custom prompt active" badge, the "✎ Custom prompt" pill
  (opens the Prompt view) and the subtab dot appear.
- `/api/chat` carries `systemPrompt` only while a custom prompt is active; it
  survives a reload and reaches a second tab; over 40,000 characters can't be
  saved; saving the default text counts as the default.
- Reset to default asks first (Cancel keeps it, OK resets).
- Headset panel: the Prompt section draws, Send appends a line, Reset takes two
  presses, the subtabs switch the DOM sections too.
- The lighting recipe the prompt describes runs as a vr-exec block
  (RoomEnvironment dynamic import, PCFSoft shadows, ACES, named default lights).
- Phones (390x844, 844x390): 16px editor, 44px buttons, Android-style keyboard
  gives the compact layout with the editor and Save in view, Save keeps focus,
  the pill fits, sends carry the prompt, reset works, no console errors.

`upstream.mjs` checks, for server.js and the Worker, with a Claude and an
OpenAI backend: no `systemPrompt` → `SYSTEM_PROMPT`; custom → custom +
`CHAT_PROMPT_REQUIRED`; messages unchanged; blank → default; 40,001 characters
or a non-string → 400 with no upstream call; 40,000 accepted; `/api/theme-chat`
and `/api/fix-code` ignore it; `/api/prompts` returns the new fields; the
generated `worker/prompts.js` matches server.js.
