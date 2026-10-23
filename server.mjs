// Call Joe server: serves the call page, keeps each friend's persona and memory, and talks to Claude.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

const dir = path.dirname(fileURLToPath(import.meta.url));
// CALLJOE_DATA and CALLJOE_PORT let a test copy run beside the real one without touching your data.
const dataDir = process.env.CALLJOE_DATA || path.join(dir, "data");
fs.mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.CALLJOE_PORT) || 5174;
// Models a friend can think with. Thinking is kept as low as each model allows so they answer quickly.
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
const MEMORY_MODEL = "claude-opus-5-5"; // writes each friend's notes after each call
const IDLE_SHUTDOWN_MS = 3 * 60 * 1000;

const configFile = path.join(dataDir, "config.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

let config = readJson(configFile, {});
let client = null;
let call = null; // { contactId, system, messages, started }
let lastPing = Date.now();

// ---- Python helpers on the graphics card, started on demand: Chatterbox (voice cloning) and Ditto (talking face) ----
// Each one quits by itself about 30 seconds after this server stops answering /api/alive.
function pythonHelper(name, folder, script, port) {
  const python = path.join(dir, folder, ".venv", "Scripts", "python.exe");
  const url = `http://127.0.0.1:${port}`;
  let proc = null;
  const health = () => fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
  process.on("exit", () => proc?.kill());
  return {
    url,
    async start() {
      if (proc || !fs.existsSync(python) || (await health())) return;
      const log = fs.openSync(path.join(dataDir, `${name}.log`), "a");
      proc = spawn(python, [path.join(dir, folder, script), String(port), String(PORT)], {
        cwd: dir, stdio: ["ignore", log, log], windowsHide: true,
      });
      proc.on("exit", () => { proc = null; });
    },
    async status() {
      if (!fs.existsSync(python)) return { installed: false };
      const h = await health();
      return { installed: true, running: !!(h || proc), ready: !!h?.ready, error: h?.error ?? null, device: h?.device ?? null };
    },
  };
}

const chatterbox = pythonHelper("chatterbox", "voice", "chatterbox_server.py", 5175);
const faceEngine = pythonHelper("face", "video", "face_server.py", 5176);

const voicesDir = path.join(dataDir, "voices"); // voice samples to clone; private, never committed
const facesDir = path.join(dataDir, "faces"); // face pictures for video calls; private, never committed
fs.mkdirSync(voicesDir, { recursive: true });
fs.mkdirSync(facesDir, { recursive: true });

const faceFile = (name) => {
  const clean = voiceName(name);
  const file = clean && path.join(facesDir, `${clean}.png`);
  return file && fs.existsSync(file) ? file : null;
};

// Voice sample names are plain file names inside data/voices.
const voiceName = (name) => String(name || "").replace(/[^\w\- ]/g, "").trim().slice(0, 40);
function voiceFile(name) {
  const clean = voiceName(name);
  const file = clean && path.join(voicesDir, `${clean}.wav`);
  return file && fs.existsSync(file) ? file : null;
}

// ---- Contacts: each friend has a persona in contacts/<id>/persona.md (in git) and private data in data/contacts/<id>/ ----
// data/contacts/<id>/contact.json  name and settings (model, voice, face)
// data/contacts/<id>/memory.json   what they remember about you; never reset or shared with another friend
// data/contacts/<id>/call-log.txt  every call's transcript
const personasDir = path.join(dir, "contacts");
const contactsDir = path.join(dataDir, "contacts");
fs.mkdirSync(contactsDir, { recursive: true });
// Every friend talks with a Chatterbox voice cloned from their clip (cbVoice); face is optional (video calls).
const SETTING_KEYS = ["model", "cbVoice", "face"];

const validId = (id) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(id || ""));
const contactPath = (id, file) => path.join(contactsDir, id, file);
const firstName = (c) => c.name.split(/\s+/)[0];

function loadContact(id) {
  if (!validId(id)) return null;
  const info = readJson(contactPath(id, "contact.json"), null);
  if (!info || !fs.existsSync(path.join(personasDir, id, "persona.md"))) return null;
  const memory = readJson(contactPath(id, "memory.json"), { notes: "", calls: 0, lastCall: null });
  return { ...info, id, settings: info.settings ?? {}, memory };
}

function saveContact(c) {
  const { id, memory, ...info } = c;
  writeJson(contactPath(id, "contact.json"), info);
}

const listContacts = () =>
  fs.readdirSync(contactsDir).map(loadContact).filter(Boolean)
    .sort((a, b) => (a.id === "joe" ? -1 : b.id === "joe" ? 1 : a.name.localeCompare(b.name)));

// One-time move from the single-friend layout (data/memory.json, data/call-log.txt) into data/contacts/joe/.
// The old files are copied to data/backup-before-contacts/ first. Joe's notes and log move over unchanged.
function moveJoeIntoContacts() {
  if (fs.existsSync(contactPath("joe", "contact.json"))) return;
  const oldMemory = path.join(dataDir, "memory.json");
  const oldLog = path.join(dataDir, "call-log.txt");
  const backup = path.join(dataDir, "backup-before-contacts");
  fs.mkdirSync(backup, { recursive: true });
  for (const f of [oldMemory, oldLog, configFile]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backup, path.basename(f)));
  fs.mkdirSync(path.join(contactsDir, "joe"), { recursive: true });
  if (fs.existsSync(oldMemory)) fs.renameSync(oldMemory, contactPath("joe", "memory.json"));
  if (fs.existsSync(oldLog)) fs.renameSync(oldLog, contactPath("joe", "call-log.txt"));
  const settings = { model: MODELS[config.model] ? config.model : DEFAULT_MODEL };
  if (fs.existsSync(path.join(facesDir, "Joe.png"))) settings.face = "Joe";
  // "legacy" tells the call screen to bring over Joe's voice settings, which used to live only in the browser.
  writeJson(contactPath("joe", "contact.json"), { name: "Joe Dirt", created: new Date().toISOString(), legacy: true, settings });
  console.log("Moved Joe into data/contacts/joe (backup in data/backup-before-contacts)");
}
moveJoeIntoContacts();

function getClient() {
  if (!config.apiKey) return null;
  client ??= new Anthropic({ apiKey: config.apiKey });
  return client;
}

const chatModel = (c) => MODELS[c?.settings.model] ?? MODELS[DEFAULT_MODEL];

// Built once per call and left unchanged during it, so the prompt cache keeps hitting.
function systemPrompt(c) {
  const persona = fs.readFileSync(path.join(personasDir, c.id, "persona.md"), "utf8");
  const memory = c.memory;
  const now = new Date().toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const mem = memory.notes
    ? `What you remember about your buddy from past calls:\n${memory.notes}`
    : "This is the first time this buddy has ever called you. You don't know their name or anything about them yet.";
  const last = memory.lastCall ? `Your last call with them was ${memory.lastCall}.` : "";
  return `${persona}\n\n# Memory\n${mem}${linkedNews(c)}\n\n# Right now\nIt's ${now} where you both live. ${last}`;
}

// Linked friends (like a married couple) share what the buddy told each of them, the way they'd talk it over at
// dinner. Links are set with `tools/contact.py link` and stored in contact.json as [{ id, relation }]. Friends
// without links get nothing here, so they still only know their own calls.
function linkedNews(c) {
  return (c.links ?? []).map(({ id, relation }) => {
    const other = loadContact(id);
    if (!other) return "";
    const them = firstName(other);
    const heard = other.memory.notes
      ? `What ${them} has told you about your buddy, from their own calls with ${them} (the last one was ${other.memory.lastCall}):\n${other.memory.notes}`
      : `Your buddy hasn't talked with ${them} on the phone yet.`;
    return `\n\n# ${other.name}, ${relation}\n${other.name} is ${relation}. Your buddy is ${them}'s friend too and talks with ${them} on separate calls, and the two of you tell each other about those calls. You can mention what ${them} told you, but you weren't on those calls yourself.\n${heard}`;
  }).join("");
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : content.filter((b) => b.type === "text").map((b) => b.text).join("");

// Streams Joe's next reply as plain text and records the full turn in the call history.
async function streamReply(res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  try {
    const model = chatModel(loadContact(call.contactId));
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
  const c = loadContact(ended.contactId);
  if (!c) return;
  const first = firstName(c);
  const memory = c.memory;
  const memoryFile = contactPath(c.id, "memory.json");
  const transcript = ended.messages
    .slice(1)
    .map((m) => `${m.role === "user" ? "Buddy" : first}: ${textOf(m.content)}`)
    .join("\n");
  memory.calls += 1;
  memory.lastCall = ended.started.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  fs.appendFileSync(contactPath(c.id, "call-log.txt"), `\n===== Call on ${memory.lastCall} =====\n${transcript}\n`);
  if (transcript.trim()) {
    try {
      const msg = await getClient().messages.create({
        model: MEMORY_MODEL,
        max_tokens: 8000,
        output_config: { effort: "low" },
        system:
          `You keep ${c.name}'s private memory notes about their buddy, the person who calls them. ` +
          `Merge what was learned on the newest call into the existing notes. Keep facts about the buddy (name, family, job, likes, worries, plans, what's going on in their life), things ${first} promised to ask about next time, and any details ${first} made up about their own life so they stay consistent. ` +
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

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too big")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // The Chatterbox helper checks /api/alive so it can quit when Joe does; that check doesn't keep Joe awake.
  if (url.pathname === "/api/alive") return json(res, 200, { ok: true });
  lastPing = Date.now();

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(dir, "index.html")));
  }
  if (url.pathname === "/api/status") {
    return json(res, 200, { hasKey: !!config.apiKey, inCall: call?.contactId ?? null });
  }
  if (url.pathname === "/api/ping") return json(res, 200, { ok: true });

  if (req.method === "POST" && url.pathname === "/api/key") {
    const { key } = await readBody(req);
    const test = new Anthropic({ apiKey: (key || "").trim() });
    try {
      await test.models.retrieve(chatModel(null).id);
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

  // ---- Chatterbox voices ----
  if (url.pathname === "/api/chatterbox/status") return json(res, 200, await chatterbox.status());
  if (req.method === "POST" && url.pathname === "/api/chatterbox/start") {
    await chatterbox.start();
    return json(res, 200, await chatterbox.status());
  }

  // ---- Video calls: face pictures and the talking-face engine ----
  if (url.pathname === "/api/video/status") return json(res, 200, await faceEngine.status());
  if (req.method === "POST" && url.pathname === "/api/video/start") {
    await faceEngine.start();
    return json(res, 200, await faceEngine.status());
  }
  if (req.method === "GET" && url.pathname === "/api/faces") {
    const names = fs.readdirSync(facesDir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4));
    return json(res, 200, names.sort());
  }
  if (req.method === "GET" && url.pathname === "/api/face") {
    const file = faceFile(url.searchParams.get("name"));
    if (!file) return json(res, 404, { error: "No such face." });
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === "POST" && url.pathname === "/api/faces") {
    const name = voiceName(url.searchParams.get("name"));
    if (!name) return json(res, 400, { error: "Give the face a name." });
    const img = await readRaw(req, 15 * 1024 * 1024).catch(() => null);
    if (!img || img.subarray(1, 4).toString() !== "PNG") return json(res, 400, { error: "That picture didn't come through. Try again." });
    fs.writeFileSync(path.join(facesDir, `${name}.png`), img);
    return json(res, 200, { ok: true, name });
  }
  // Frames come back as a stream of [4-byte length][JPEG], drawn while the call screen is already playing them.
  if (url.pathname === "/api/video/idle" || (req.method === "POST" && url.pathname === "/api/video/frames")) {
    const file = faceFile(url.searchParams.get("face"));
    if (!file) return json(res, 400, { error: "Pick a face picture for video calls first." });
    await faceEngine.start();
    const idle = url.pathname === "/api/video/idle";
    const body = idle ? undefined : await readRaw(req, 25 * 1024 * 1024).catch(() => null);
    const r = await fetch(`${faceEngine.url}/${idle ? "idle" : "render"}?face=${encodeURIComponent(file)}`, {
      method: idle ? "GET" : "POST", body,
    }).catch(() => null);
    if (!r) return json(res, 502, { error: "The video engine is still starting up." });
    if (!r.ok) {
      const out = await r.json().catch(() => ({}));
      return json(res, 502, { error: r.status === 503 ? "The video engine is still loading." : `Video had a problem: ${out.error ?? r.status}` });
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-cache" });
    const stream = Readable.fromWeb(r.body);
    res.on("close", () => stream.destroy()); // hushed or hung up: stop drawing frames nobody will see
    return stream.pipe(res);
  }
  if (req.method === "GET" && url.pathname === "/api/voices") {
    const names = fs.readdirSync(voicesDir).filter((f) => f.endsWith(".wav")).map((f) => f.slice(0, -4));
    return json(res, 200, names.sort());
  }
  if (req.method === "POST" && url.pathname === "/api/voices") {
    const name = voiceName(url.searchParams.get("name"));
    if (!name) return json(res, 400, { error: "Give the voice a name." });
    const audio = await readRaw(req, 25 * 1024 * 1024).catch(() => null);
    if (!audio || audio.subarray(0, 4).toString() !== "RIFF") return json(res, 400, { error: "That recording didn't come through. Try again." });
    fs.writeFileSync(path.join(voicesDir, `${name}.wav`), audio);
    return json(res, 200, { ok: true, name });
  }

  if (req.method === "POST" && url.pathname === "/api/tts") {
    const { text, voice } = await readBody(req);
    const file = voiceFile(voice);
    if (!file) return json(res, 400, { error: "This friend needs a voice clip. Add one in their ⚙ settings." });
    await chatterbox.start();
    const r = await fetch(`${chatterbox.url}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text || "").slice(0, 1000), voice_path: file }),
    }).catch(() => null);
    if (!r) return json(res, 502, { error: "Chatterbox is still starting up." });
    if (!r.ok) {
      const out = await r.json().catch(() => ({}));
      return json(res, 502, { error: r.status === 503 ? "Chatterbox is still loading." : `Chatterbox had a problem: ${out.error ?? r.status}` });
    }
    res.writeHead(200, { "Content-Type": "audio/wav" });
    return Readable.fromWeb(r.body).pipe(res);
  }

  // ---- Contacts ----
  if (req.method === "GET" && url.pathname === "/api/contacts") {
    return json(res, 200, listContacts().map((c) => ({
      id: c.id, name: c.name, face: c.settings.face && faceFile(c.settings.face) ? c.settings.face : null,
      hasVoice: !!voiceFile(c.settings.cbVoice),
      calls: c.memory.calls, lastCall: c.memory.lastCall,
    })));
  }
  const contactRoute = url.pathname.match(/^\/api\/contacts\/([a-z0-9-]+)$/);
  if (contactRoute) {
    const c = loadContact(contactRoute[1]);
    if (!c) return json(res, 404, { error: "No such friend." });
    if (req.method === "PUT") {
      const { settings = {} } = await readBody(req);
      for (const k of SETTING_KEYS) if (k in settings) c.settings[k] = settings[k];
      if (c.settings.model && !MODELS[c.settings.model]) c.settings.model = DEFAULT_MODEL;
      delete c.legacy;
      saveContact(c);
    }
    return json(res, 200, {
      id: c.id, name: c.name, firstName: firstName(c), settings: c.settings, legacy: !!c.legacy,
      calls: c.memory.calls, lastCall: c.memory.lastCall,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    if (!getClient()) return json(res, 400, { error: "No API key yet." });
    const c = loadContact((await readBody(req)).contact);
    if (!c) return json(res, 400, { error: "No such friend." });
    if (call) await hangUp();
    call = {
      contactId: c.id,
      started: new Date(),
      system: systemPrompt(c),
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
