import { CHAT_PROMPT_REQUIRED, FIX_CODE_PROMPT, MAX_CUSTOM_PROMPT_CHARS, SYSTEM_PROMPT, THEME_SYSTEM_PROMPT } from "./prompts.js";

// Hosted Worker for Carl Junior. Local-only HTTPS / self-signed certs / port
// binding from site-source/server.js are intentionally not included: Workers
// terminates TLS and does not listen on a port.
// Static client files are Workers static assets (ASSETS). This module only
// handles /api/* plus the /s/:id and /e/:id share routes.

const LLM_BACKEND_DEFAULT = "openai-sol";
const OPENAI_MODEL_DEFAULT = "gpt-6-astra";
const OPENAI_SOL_MODEL = "gpt-6.1-sol";
const FABLE_THINKING_BUDGET = 4096;
const SCENE_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

// Same as resolveChatPrompt in site-source/server.js: the default Scene chat
// prompt, or the user's custom prompt (Chat → Prompt) plus the required
// technical section, capped at MAX_CUSTOM_PROMPT_CHARS.
function resolveChatPrompt(custom) {
  if (custom == null || custom === "") return { prompt: SYSTEM_PROMPT, custom: false };
  if (typeof custom !== "string") return { error: "systemPrompt must be a string" };
  if (!custom.trim()) return { prompt: SYSTEM_PROMPT, custom: false };
  if (custom.length > MAX_CUSTOM_PROMPT_CHARS) return { error: `Custom prompt is too long (${custom.length} characters, max ${MAX_CUSTOM_PROMPT_CHARS}). Shorten it in Chat → Prompt.` };
  return { prompt: `${custom.trim()}\n\n${CHAT_PROMPT_REQUIRED}`, custom: true };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
      "access-control-allow-headers": "content-type",
      ...extraHeaders,
    },
  });
}

// Backend key -> provider/model/label. Order here is dropdown order (newest/
// best first within each provider). Keys are stable: never rename one.
// model: null on "openai" means env.OPENAI_MODEL || OPENAI_MODEL_DEFAULT.
const BACKENDS = {
  "claude-opus-55": { provider: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
  "claude-sonnet-55": { provider: "claude", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  "claude-haiku-55": { provider: "claude", model: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  fable: { provider: "claude", model: "claude-fable-5-1", label: "Claude (Fable 5.1)" },
  claude: { provider: "claude", model: "claude-sonnet-5", label: "Claude (Sonnet 5)" },
  "openai-sol": { provider: "openai", model: OPENAI_SOL_MODEL, label: "GPT6.1 Sol" },
  "openai-6-sol": { provider: "openai", model: "gpt-6-sol", label: "GPT6 Sol" },
  "openai-luna": { provider: "openai", model: "gpt-6-luna", label: "GPT6 Luna" },
  openai: { provider: "openai", model: null, label: "GPT6 Astra" },
  ollama: { provider: "ollama", label: "Ollama (runs in your browser, local)", local: true },
};

function getAvailableBackends(env) {
  const out = {};
  for (const [id, b] of Object.entries(BACKENDS)) {
    const available = b.provider === "ollama" ? true : b.provider === "openai" ? !!env.OPENAI_API_KEY : !!env.CLAUDE_API_KEY;
    out[id] = { label: b.label, provider: b.provider, available, ...(b.local ? { local: true } : {}) };
  }
  return out;
}

async function callClaudeAPI(apiKey, systemPrompt, messages, maxTokens, model) {
  const isFable = model === "claude-fable-5-1";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: isFable ? maxTokens + FABLE_THINKING_BUDGET : maxTokens,
      ...(model === "claude-sonnet-5" ? { thinking: { type: "disabled" } } : {}),
      // Fable 5.1 rejects thinking.type "enabled"; adaptive + effort is required.
      ...(isFable ? { thinking: { type: "adaptive" }, output_config: { effort: "medium" } } : {}),
      system: systemPrompt,
      messages,
    }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
  }
  if (res.status >= 400) return { error: true, status: res.status, data: parsed };
  if (Array.isArray(parsed.content)) {
    const textBlock = parsed.content.find((b) => b.type === "text");
    if (textBlock && parsed.content[0] !== textBlock) {
      parsed.content = [textBlock, ...parsed.content.filter((b) => b !== textBlock)];
    }
  }
  return { error: false, data: parsed };
}

async function callOpenAIAPI(apiKey, systemPrompt, messages, maxTokens, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response from OpenAI: ${text.slice(0, 200)}`);
  }
  if (res.status >= 400) {
    return { error: true, status: res.status, data: { error: { message: parsed.error?.message || text } } };
  }
  const answer = parsed.choices?.[0]?.message?.content || "";
  return { error: false, data: { content: [{ text: answer }] } };
}

function callLLM(env, systemPrompt, messages, maxTokens, backend) {
  const chosen = (backend || env.LLM_BACKEND || LLM_BACKEND_DEFAULT).toLowerCase();
  if (chosen === "ollama") {
    return Promise.resolve({
      error: true,
      status: 400,
      data: { error: { message: "Ollama requests should go directly from the browser to localhost:11434, not through this server." } },
    });
  }
  // Unknown keys fall back to Claude Sonnet 5 (the old default behavior).
  const entry = BACKENDS[chosen] || BACKENDS.claude;
  if (entry.provider === "openai") {
    if (!env.OPENAI_API_KEY) {
      return Promise.resolve({ error: true, status: 400, data: { error: { message: "OPENAI_API_KEY is not configured on the server." } } });
    }
    const model = entry.model || env.OPENAI_MODEL || OPENAI_MODEL_DEFAULT;
    return callOpenAIAPI(env.OPENAI_API_KEY, systemPrompt, messages, maxTokens, model);
  }
  if (!env.CLAUDE_API_KEY) {
    return Promise.resolve({ error: true, status: 400, data: { error: { message: "CLAUDE_API_KEY is not configured on the server." } } });
  }
  const model = entry.model;
  return callClaudeAPI(env.CLAUDE_API_KEY, systemPrompt, messages, maxTokens, model);
}

function newSceneId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return Date.now().toString(36) + hex;
}

function sanitizeSceneName(name) {
  const cleaned = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "Untitled").slice(0, 80);
}

function createdAtGuessFromId(id) {
  if (!id || id.length <= 8) return null;
  const tsPart = id.slice(0, -8);
  const ms = parseInt(tsPart, 36);
  if (!Number.isFinite(ms) || ms < 1e12 || ms > 4e12) return null;
  return new Date(ms).toISOString();
}

function requestOrigin(request) {
  return new URL(request.url).origin;
}

function sceneUrls(request, id) {
  const origin = requestOrigin(request);
  return { id, editorUrl: `${origin}/e/${id}`, viewUrl: `${origin}/s/${id}` };
}

function requireStore(env) {
  if (!env.SCENES) return json({ error: "Community uploads aren't configured on this server (no Blob store linked)." }, 501);
  return null;
}

async function readJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function kvGetJson(env, key) {
  const raw = await env.SCENES.get(key);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function readIndex(env, key) {
  return (await kvGetJson(env, key)) || [];
}

function listItemTimestamps(meta) {
  const updatedAt = meta.updatedAt || meta.uploadedAt || null;
  const createdAt = meta.createdAt || createdAtGuessFromId(meta.id) || updatedAt;
  return { createdAt, updatedAt };
}

function sanitizeThemePayload(body) {
  const name = sanitizeSceneName(body?.name);
  const cssVars = body?.cssVars && typeof body.cssVars === "object" && !Array.isArray(body.cssVars) ? body.cssVars : null;
  if (!cssVars || Object.keys(cssVars).length === 0) return { error: "Invalid theme: cssVars object required" };
  const cleaned = {};
  for (const [k, v] of Object.entries(cssVars)) {
    if (typeof k !== "string" || !k.startsWith("--")) continue;
    if (typeof v !== "string") continue;
    cleaned[k.slice(0, 64)] = String(v).slice(0, 500);
  }
  if (Object.keys(cleaned).length === 0) return { error: "Invalid theme: no usable cssVars" };
  let customCSS = "";
  if (typeof body.customCSS === "string") customCSS = body.customCSS.slice(0, 8000);
  return { name, cssVars: cleaned, customCSS };
}

// Creation context (chat log + info log) uploaded with a community scene as
// `creationContext` = { format, version, encoding, data, summary }. Stored
// under its own KV key so the scene record and list stay small; the record
// keeps a stub pointing at GET /api/community-scenes/:id/context (lazy load).
// KV values max out at 25 MiB; the client keeps the encoded context under 3 MB.
const CONTEXT_FORMAT = "gs-creation-context";
const CONTEXT_MAX_CHARS = 20 * 1024 * 1024;
const contextKey = (id) => `scene:${id}:context`;

function validCreationContext(cc) {
  return !!(cc && typeof cc === "object" && cc.format === CONTEXT_FORMAT &&
    (cc.encoding === "gzip-base64" ? typeof cc.data === "string" : cc.encoding === "json" && cc.data && typeof cc.data === "object"));
}

function contextStub(cc, id, extra = {}) {
  return {
    format: CONTEXT_FORMAT,
    version: cc.version || 1,
    encoding: cc.encoding,
    stored: "separate",
    url: `/api/community-scenes/${id}/context`,
    summary: cc.summary && typeof cc.summary === "object" ? cc.summary : null,
    ...extra,
  };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return json({ ok: true });

  if (method === "GET" && path === "/api/backends") {
    return json({
      backends: getAvailableBackends(env),
      default: (env.LLM_BACKEND || LLM_BACKEND_DEFAULT).toLowerCase(),
    });
  }

  if (method === "GET" && path === "/api/prompts") {
    return json({
      systemPrompt: SYSTEM_PROMPT,
      fixCodePrompt: FIX_CODE_PROMPT,
      themePrompt: THEME_SYSTEM_PROMPT,
      chatPromptRequired: CHAT_PROMPT_REQUIRED,
      maxCustomPromptChars: MAX_CUSTOM_PROMPT_CHARS,
    });
  }

  // Read-only relay for public p5.js web editor sketches (same as server.js
  // GET /api/p5-editor/:user/:id). editor.p5js.org sends no CORS headers, so
  // the browser can't fetch it directly. Only this one public project-JSON
  // endpoint on editor.p5js.org is reachable; username and id are validated.
  const p5EditorMatch = path.match(/^\/api\/p5-editor\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && p5EditorMatch) {
    let user, id;
    try { user = decodeURIComponent(p5EditorMatch[1]); id = decodeURIComponent(p5EditorMatch[2]); } catch { user = id = ""; }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(user) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return json({ error: "Invalid p5 editor username or sketch id" }, 400);
    }
    try {
      const upstream = await fetch(`https://editor.p5js.org/editor/${encodeURIComponent(user)}/projects/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (upstream.status === 404) return json({ error: "Sketch not found", notFound: true }, 404);
      if (!upstream.ok) return json({ error: `p5 editor returned HTTP ${upstream.status}` }, 502);
      const data = await upstream.json();
      if (!data || !Array.isArray(data.files)) return json({ error: "Sketch not found", notFound: true }, 404);
      return json({ name: data.name, files: data.files, user: data.user && { username: data.user.username } }, 200, { "cache-control": "public, max-age=60" });
    } catch (err) {
      return json({ error: `Could not reach the p5 editor: ${err.message}` }, 502);
    }
  }

  if (method === "POST" && (path === "/api/chat" || path === "/api/fix-code" || path === "/api/theme-chat")) {
    const body = await readJsonBody(request);
    if (body == null) return json({ error: "Invalid JSON" }, 400);
    try {
      let data;
      if (path === "/api/chat" || path === "/api/theme-chat") {
        if (!body.messages || !Array.isArray(body.messages)) return json({ error: "Messages array is required" }, 400);
        let prompt = THEME_SYSTEM_PROMPT;
        if (path === "/api/chat") {
          // Optional custom Scene chat prompt from Chat → Prompt.
          const resolved = resolveChatPrompt(body.systemPrompt);
          if (resolved.error) return json({ error: resolved.error }, 400);
          prompt = resolved.prompt;
        }
        const maxTokens = path === "/api/chat" ? 16384 : 4096;
        data = await callLLM(env, prompt, body.messages, maxTokens, body.backend);
      } else {
        const { failingCode, errorMessage, errorStack, attempt, priorFixes, backend, sceneContext } = body;
        if (!failingCode || !errorMessage) return json({ error: "failingCode and errorMessage are required" }, 400);
        let userContent = `The following vr-exec code block failed to execute.\n\n`;
        userContent += `**Error:** \`${errorMessage}\`\n`;
        if (errorStack) userContent += `**Stack:** \`${errorStack}\`\n`;
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
        // Editor settings note from the client (Environment, Dependencies, gamepad), capped.
        if (typeof sceneContext === "string" && sceneContext.trim()) {
          userContent += `\n\n${sceneContext.slice(0, 8000)}`;
        }
        data = await callLLM(env, FIX_CODE_PROMPT, [{ role: "user", content: userContent }], 8192, backend);
      }
      if (data.error) {
        return json({ error: data.data.error?.message || `API error: ${data.status}` }, data.status || 500);
      }
      return json(data.data);
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  }

  if (path === "/api/save-scene" && method === "POST") {
    const missing = requireStore(env);
    if (missing) return missing;
    const sceneData = await readJsonBody(request);
    if (!sceneData || !sceneData.codeBlocks || !Array.isArray(sceneData.codeBlocks)) {
      return json({ error: "Invalid scene data: missing codeBlocks array" }, 400);
    }
    await env.SCENES.put("saved-scene", JSON.stringify(sceneData));
    return json({ ok: true, file: "saved-scene.vrscene" });
  }

  if (path === "/api/load-scene" && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const raw = await env.SCENES.get("saved-scene");
    if (!raw) return json({ error: "No saved scene found" }, 404);
    return json(JSON.parse(raw));
  }

  const sceneIdMatch = path.match(/^\/api\/community-scenes\/([^/]+)$/);
  const sceneContextMatch = path.match(/^\/api\/community-scenes\/([^/]+)\/context$/);

  if (sceneContextMatch && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneContextMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const raw = await env.SCENES.get(contextKey(id));
    if (raw) return new Response(raw, { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
    // Older uploads from unpatched servers keep the context inline.
    const record = await kvGetJson(env, `cs:${id}`);
    if (!record) return json({ error: "Scene not found" }, 404);
    if (record.creationContext && record.creationContext.data) return json(record.creationContext);
    return json({ error: "This scene has no creation context" }, 404);
  }
  const themeIdMatch = path.match(/^\/api\/community-themes\/([^/]+)$/);

  if (path === "/api/community-scenes" && method === "POST") {
    const missing = requireStore(env);
    if (missing) return missing;
    const sceneData = await readJsonBody(request);
    if (!sceneData || !sceneData.codeBlocks || !Array.isArray(sceneData.codeBlocks)) {
      return json({ error: "Invalid scene data: missing codeBlocks array" }, 400);
    }
    const id = newSceneId();
    const name = sanitizeSceneName(sceneData.name);
    const now = new Date().toISOString();
    const { creationContext, ...sceneFields } = sceneData;
    const record = { ...sceneFields, id, name, createdAt: sceneData.createdAt || now, updatedAt: now };
    if (creationContext != null) {
      if (!validCreationContext(creationContext)) return json({ error: "Invalid creationContext" }, 400);
      const ctxEncoded = JSON.stringify(creationContext);
      if (ctxEncoded.length > CONTEXT_MAX_CHARS) return json({ error: "Creation context is too large" }, 413);
      await env.SCENES.put(contextKey(id), ctxEncoded);
      record.creationContext = contextStub(creationContext, id, { key: contextKey(id), size: ctxEncoded.length });
    }
    const encoded = JSON.stringify(record);
    await env.SCENES.put(`cs:${id}`, encoded);
    const meta = { id, name, uploadedAt: now, createdAt: record.createdAt, updatedAt: now, size: new TextEncoder().encode(encoded).length, pathname: `community-scenes/${id}--${encodeURIComponent(name)}.json` };
    const index = await readIndex(env, "cs-index");
    index.unshift(meta);
    await env.SCENES.put("cs-index", JSON.stringify(index));
    return json({
      ok: true,
      url: `${requestOrigin(request)}/api/community-scenes/${id}`,
      pathname: meta.pathname,
      scene: meta,
      ...sceneUrls(request, id),
    });
  }

  if (path === "/api/community-scenes" && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const index = await readIndex(env, "cs-index");
    const scenes = index.map((s) => ({
      id: s.id,
      name: s.name,
      url: `${requestOrigin(request)}/api/community-scenes/${s.id}`,
      pathname: s.pathname,
      uploadedAt: s.uploadedAt,
      size: s.size,
      ...listItemTimestamps(s),
      ...sceneUrls(request, s.id),
    }));
    return json({ scenes });
  }

  if (sceneIdMatch && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneIdMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const record = await kvGetJson(env, `cs:${id}`);
    if (!record) return json({ error: "Scene not found" }, 404);
    return json({ ...record, ...sceneUrls(request, id) });
  }

  if (sceneIdMatch && method === "PATCH") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(sceneIdMatch[1]);
    const body = await readJsonBody(request);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Scene not found" }, 404);
    const record = await kvGetJson(env, `cs:${id}`);
    if (!record) return json({ error: "Scene not found" }, 404);
    if (body == null || body.name == null) return json({ error: "Missing name" }, 400);
    const name = sanitizeSceneName(body.name);
    record.name = name;
    record.id = id;
    record.updatedAt = new Date().toISOString();
    const encoded = JSON.stringify(record);
    await env.SCENES.put(`cs:${id}`, encoded);
    const index = await readIndex(env, "cs-index");
    const next = index.map((s) => s.id === id ? { ...s, name, updatedAt: record.updatedAt, uploadedAt: record.updatedAt, size: new TextEncoder().encode(encoded).length, pathname: `community-scenes/${id}--${encodeURIComponent(name)}.json` } : s);
    await env.SCENES.put("cs-index", JSON.stringify(next));
    const meta = next.find((s) => s.id === id);
    return json({
      ok: true,
      url: `${requestOrigin(request)}/api/community-scenes/${id}`,
      pathname: meta.pathname,
      scene: { id, name, uploadedAt: record.updatedAt, createdAt: record.createdAt || null, updatedAt: record.updatedAt, size: meta.size },
      ...sceneUrls(request, id),
    });
  }

  if (path === "/api/community-themes" && method === "POST") {
    const missing = requireStore(env);
    if (missing) return missing;
    const body = await readJsonBody(request);
    const cleaned = sanitizeThemePayload(body);
    if (cleaned.error) return json({ error: cleaned.error }, 400);
    const id = newSceneId();
    const now = new Date().toISOString();
    const record = {
      id,
      name: cleaned.name,
      cssVars: cleaned.cssVars,
      customCSS: cleaned.customCSS || "",
      createdAt: body?.createdAt || now,
      updatedAt: now,
    };
    const encoded = JSON.stringify(record);
    await env.SCENES.put(`ct:${id}`, encoded);
    const meta = { id, name: cleaned.name, uploadedAt: now, createdAt: record.createdAt, updatedAt: now, size: new TextEncoder().encode(encoded).length, pathname: `community-themes/${id}--${encodeURIComponent(cleaned.name)}.json` };
    const index = await readIndex(env, "ct-index");
    index.unshift(meta);
    await env.SCENES.put("ct-index", JSON.stringify(index));
    return json({
      ok: true,
      url: `${requestOrigin(request)}/api/community-themes/${id}`,
      pathname: meta.pathname,
      theme: { id, name: cleaned.name, uploadedAt: now, createdAt: record.createdAt, updatedAt: record.updatedAt, size: meta.size },
    });
  }

  if (path === "/api/community-themes" && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const index = await readIndex(env, "ct-index");
    const themes = index.map((t) => ({
      id: t.id,
      name: t.name,
      url: `${requestOrigin(request)}/api/community-themes/${t.id}`,
      pathname: t.pathname,
      uploadedAt: t.uploadedAt,
      size: t.size,
      ...listItemTimestamps(t),
    }));
    return json({ themes });
  }

  if (themeIdMatch && method === "GET") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(themeIdMatch[1]);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Theme not found" }, 404);
    const record = await kvGetJson(env, `ct:${id}`);
    if (!record) return json({ error: "Theme not found" }, 404);
    return json(record);
  }

  if (themeIdMatch && method === "PATCH") {
    const missing = requireStore(env);
    if (missing) return missing;
    const id = decodeURIComponent(themeIdMatch[1]);
    const body = await readJsonBody(request);
    if (!SCENE_ID_RE.test(id)) return json({ error: "Theme not found" }, 404);
    const record = await kvGetJson(env, `ct:${id}`);
    if (!record) return json({ error: "Theme not found" }, 404);
    if (body == null || body.name == null) return json({ error: "Missing name" }, 400);
    const name = sanitizeSceneName(body.name);
    record.name = name;
    record.id = id;
    record.updatedAt = new Date().toISOString();
    const encoded = JSON.stringify(record);
    await env.SCENES.put(`ct:${id}`, encoded);
    const index = await readIndex(env, "ct-index");
    const next = index.map((t) => t.id === id ? { ...t, name, updatedAt: record.updatedAt, uploadedAt: record.updatedAt, size: new TextEncoder().encode(encoded).length, pathname: `community-themes/${id}--${encodeURIComponent(name)}.json` } : t);
    await env.SCENES.put("ct-index", JSON.stringify(next));
    const meta = next.find((t) => t.id === id);
    return json({
      ok: true,
      url: `${requestOrigin(request)}/api/community-themes/${id}`,
      pathname: meta.pathname,
      theme: { id, name, uploadedAt: record.updatedAt, createdAt: record.createdAt || null, updatedAt: record.updatedAt, size: meta.size },
    });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api" || path.startsWith("/api/")) {
      return handleApi(request, env);
    }
    if (/^\/[se]\/[^/]+\/?$/.test(path)) {
      const indexUrl = new URL(request.url);
      indexUrl.pathname = "/index.html";
      indexUrl.search = "";
      return env.ASSETS.fetch(new Request(indexUrl.toString(), { method: "GET" }));
    }
    return env.ASSETS.fetch(request);
  },
};
