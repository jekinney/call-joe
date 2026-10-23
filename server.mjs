// Joe Dirt call server: serves the call page and talks to Claude.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import Anthropic from "@anthropic-ai/sdk";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dir, "data");
fs.mkdirSync(dataDir, { recursive: true });

const PORT = 5174;
// Models Joe can talk on. Thinking is kept as low as each model allows so he answers quickly.
const MODELS = {
  haiku: {
    id: "claude-haiku-5-5",
    params: { thinking: { type: "disabled" } },
  },
  sonnet: {
    id: "claude-sonnet-5-5",
    params: { thinking: { type: "between_tools" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
  },
  opus: {
    id: "claude-opus-5-5",
    params: { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
  },
};
const DEFAULT_MODEL = "sonnet";
const MEMORY_MODEL = "claude-opus-5-5"; // writes Joe's notes after each call
const IDLE_SHUTDOWN_MS = 3 * 60 * 1000;

const configFile = path.join(dataDir, "config.json");
const memoryFile = path.join(dataDir, "memory.json");
const logFile = path.join(dataDir, "call-log.txt");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

let config = readJson(configFile, {});
let memory = readJson(memoryFile, { notes: "", calls: 0, lastCall: null });
let client = null;
let call = null; // { system, messages, started }
let lastPing = Date.now();

function getClient() {
  if (!config.apiKey) return null;
  client ??= new Anthropic({ apiKey: config.apiKey });
  return client;
}

const chatModel = () => MODELS[config.model] ?? MODELS[DEFAULT_MODEL];

// Built once per call and left unchanged during it, so the prompt cache keeps hitting.
function systemPrompt() {
  const persona = fs.readFileSync(path.join(dir, "persona.md"), "utf8");
  const now = new Date().toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const mem = memory.notes
    ? `What you remember about your buddy from past calls:\n${memory.notes}`
    : "This is the first time this buddy has ever called you. You don't know their name or anything about them yet.";
  const last = memory.lastCall ? `Your last call with them was ${memory.lastCall}.` : "";
  return `${persona}\n\n# Memory\n${mem}\n\n# Right now\nIt's ${now} where you both live. ${last}`;
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : content.filter((b) => b.type === "text").map((b) => b.text).join("");

// Streams Joe's next reply as plain text and records the full turn in the call history.
async function streamReply(res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  try {
    const model = chatModel();
    const stream = getClient().beta.messages.stream({
      model: model.id,
      max_tokens: 16000,
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
      ...model.params,
      system: call.system,
      messages: call.messages,
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        res.write(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      const line = "Huh, you cut out on me there, buddy. Say that again?";
      res.write(line);
      call.messages.push({ role: "assistant", content: line });
    } else {
      call.messages.push({ role: "assistant", content: final.content });
    }
  } catch (err) {
    console.error(err);
    call.messages.pop(); // drop the unanswered user turn so the history stays valid
    res.write("\u0000ERROR:" + (err?.message ?? String(err)));
  }
  res.end();
}

async function hangUp() {
  if (!call) return;
  const ended = call;
  call = null;
  const transcript = ended.messages
    .slice(1)
    .map((m) => `${m.role === "user" ? "Buddy" : "Joe"}: ${textOf(m.content)}`)
    .join("\n");
  memory.calls += 1;
  memory.lastCall = ended.started.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  fs.appendFileSync(logFile, `\n===== Call on ${memory.lastCall} =====\n${transcript}\n`);
  if (transcript.trim()) {
    try {
      const msg = await getClient().messages.create({
        model: MEMORY_MODEL,
        max_tokens: 8000,
        output_config: { effort: "low" },
        system:
          "You keep Joe Dirt's private memory notes about his buddy, the person who calls him. " +
          "Merge what was learned on the newest call into the existing notes. Keep facts about the buddy (name, family, job, likes, worries, plans, what's going on in their life), things Joe promised to ask about next time, and any details Joe made up about his own life so he stays consistent. " +
          "Write short plain-text bullet lines starting with '- '. Keep it under 60 lines and drop stale or trivial things. Output only the notes.",
        messages: [{
          role: "user",
          content: `Existing notes:\n${memory.notes || "(none yet)"}\n\nNewest call (${memory.lastCall}):\n${transcript}`,
        }],
      });
      if (msg.stop_reason !== "refusal") memory.notes = textOf(msg.content).trim();
    } catch (err) {
      console.error("Memory update failed:", err?.message ?? err);
    }
  }
  writeJson(memoryFile, memory);
}

const eleven = (apiPath, key, init = {}) =>
  fetch(`https://api.elevenlabs.io${apiPath}`, { ...init, headers: { ...init.headers, "xi-api-key": key } });

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  lastPing = Date.now();
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(dir, "index.html")));
  }
  if (url.pathname === "/api/status") {
    return json(res, 200, {
      hasKey: !!config.apiKey, hasEleven: !!config.elevenKey, calls: memory.calls, inCall: !!call,
      model: MODELS[config.model] ? config.model : DEFAULT_MODEL,
    });
  }
  if (url.pathname === "/api/ping") return json(res, 200, { ok: true });

  if (req.method === "POST" && url.pathname === "/api/key") {
    const { key } = await readBody(req);
    const test = new Anthropic({ apiKey: (key || "").trim() });
    try {
      await test.models.retrieve(chatModel().id);
    } catch (err) {
      const why = err?.status === 401
        ? "Make sure you copied the whole key."
        : err?.message ?? String(err);
      return json(res, 400, { error: "That key didn't work. " + why });
    }
    config.apiKey = key.trim();
    client = null;
    writeJson(configFile, config);
    return json(res, 200, { ok: true });
  }

  // ---- ElevenLabs voices (the key stays on this computer; the page only gets audio) ----
  if (req.method === "POST" && url.pathname === "/api/eleven/key") {
    const key = String((await readBody(req)).key || "").trim();
    const check = await eleven("/v1/voices", key).catch((err) => ({ ok: false, status: 0, err }));
    if (!check.ok) {
      return json(res, 400, {
        error: check.status === 401 ? "That ElevenLabs key didn't work. Make sure you copied the whole key." : "Couldn't reach ElevenLabs. Check your internet and try again.",
      });
    }
    config.elevenKey = key;
    writeJson(configFile, config);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/eleven/voices") {
    if (!config.elevenKey) return json(res, 400, { error: "No ElevenLabs key yet." });
    const r = await eleven("/v1/voices", config.elevenKey).catch(() => null);
    if (!r?.ok) return json(res, 502, { error: "Couldn't load your ElevenLabs voices." });
    const { voices = [] } = await r.json();
    return json(res, 200, voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      about: [v.labels?.accent, v.labels?.gender, v.labels?.age, v.labels?.description].filter(Boolean).join(", "),
    })));
  }

  if (req.method === "POST" && url.pathname === "/api/tts") {
    const { text, voiceId } = await readBody(req);
    if (!config.elevenKey || !voiceId) return json(res, 400, { error: "ElevenLabs isn't set up." });
    const r = await eleven(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, config.elevenKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text || "").slice(0, 2000), model_id: "eleven_flash_v2_5" }),
    }).catch(() => null);
    if (!r?.ok) {
      const detail = r ? await r.text().catch(() => "") : "";
      return json(res, 502, { error: r?.status === 401 || /quota|credits/i.test(detail) ? "ElevenLabs is out of credits or the key stopped working." : "ElevenLabs didn't answer." });
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    return Readable.fromWeb(r.body).pipe(res);
  }

  if (req.method === "POST" && url.pathname === "/api/model") {
    const { model } = await readBody(req);
    if (!MODELS[model]) return json(res, 400, { error: "Unknown model." });
    config.model = model;
    writeJson(configFile, config);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    if (!getClient()) return json(res, 400, { error: "No API key yet." });
    if (call) await hangUp();
    call = {
      started: new Date(),
      system: systemPrompt(),
      messages: [{ role: "user", content: "(Your phone rings. It's your buddy calling. Pick up and answer the way you would.)" }],
    };
    return streamReply(res);
  }

  if (req.method === "POST" && url.pathname === "/api/say") {
    const { text } = await readBody(req);
    if (!call) return json(res, 400, { error: "Not in a call." });
    call.messages.push({ role: "user", content: String(text || "").slice(0, 4000) });
    return streamReply(res);
  }

  if (req.method === "POST" && url.pathname === "/api/hangup") {
    await hangUp();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end();
});

// Shut down once the call window has been closed for a while, saving any open call first.
setInterval(async () => {
  if (Date.now() - lastPing > IDLE_SHUTDOWN_MS) {
    await hangUp();
    process.exit(0);
  }
}, 30 * 1000);

server.listen(PORT, "127.0.0.1", () => console.log(`Joe's picking up at http://localhost:${PORT}`));
