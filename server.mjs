// Call Joe server: serves the call page, keeps each friend's persona and memory, and talks to Claude.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { createKnowledge } from "./knowledge.mjs";

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
const NEWS_MODEL = "claude-haiku-5-5"; // decides what news travels between connected friends (one small call each)
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
// callsYou: how often this friend rings you while the app is open ("never", "sometimes", "often").
const SETTING_KEYS = ["model", "cbVoice", "face", "callsYou"];

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
  writeJson(contactPath("joe", "contact.json"), { name: "Joe Tucker", created: new Date().toISOString(), legacy: true, settings });
  console.log("Moved Joe into data/contacts/joe (backup in data/backup-before-contacts)");
}
moveJoeIntoContacts();

function getClient() {
  if (!config.apiKey) return null;
  client ??= new Anthropic({ apiKey: config.apiKey });
  return client;
}

const chatModel = (c) => MODELS[c?.settings.model] ?? MODELS[DEFAULT_MODEL];

// Built once per call and left unchanged during it, so the prompt cache keeps hitting. A friend with no role,
// connections or knowledge settings (like Joe) gets exactly the persona, ending-the-call, memory and time sections.
async function systemPrompt(c) {
  const persona = fs.readFileSync(path.join(personasDir, c.id, "persona.md"), "utf8");
  const memory = c.memory;
  const now = new Date().toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const mem = memory.notes
    ? `What you remember about your buddy from past calls:\n${memory.notes}`
    : "This is the first time this buddy has ever called you. You don't know their name or anything about them yet.";
  const last = memory.lastCall ? `Your last call with them was ${memory.lastCall}.` : "";
  return [
    persona.trimEnd(),
    roleRules(c),
    ENDING_THE_CALL,
    knowledge.tools(c).length ? LOOKING_THINGS_UP : "",
    `# Memory\n${mem}${connectionNews(c)}`,
    await knowledge.briefing(c),
    `# Right now\nIt's ${now} where you both live. ${last}`,
  ].filter(Boolean).join("\n\n");
}

const LOOKING_THINGS_UP = `# Looking things up
You can check real, current information with your tools: football scores and news, the weather anywhere, or a web search if you have one. Use them when your buddy asks about something current or you'd need facts you don't know, like a score, a forecast, a price or a recipe you don't know by heart.
Before you use a tool, say one short natural line out loud first, like "Hang on, let me look" or "Let me grab the paper." Then tell your buddy what you found the way a person would on the phone: the gist in a sentence or two, in your own words and with your own opinion. No lists, no links, and don't read out whole articles.
If you can't find something, say so. Never make up scores, stats, prices or forecasts.`;

// Friends can hang up. The marker is stripped from what's spoken and shown; the call screen hangs up after the
// friend finishes their goodbye.
const HANGUP = "<hangup>";
const ENDING_THE_CALL = `# Ending the call
You can hang up, like on a real phone. When the call is clearly over, because you've both said goodbye, or your buddy said they have to go and you've said bye back, finish your goodbye and put ${HANGUP} at the very end of that last message. It's a signal, not something you say.
Don't hang up during a pause, in the middle of a conversation, or while your buddy is upset or struggling. If you're not sure the call is over, don't hang up. Keep talking or ask if they need to go.`;

// ---- Roles and connections (docs/roadmap.md, section 4) ----
// A friend's role in the buddy's life (contact.json "role", like "friend" or "mom") adds contacts/_roles/<role>.md
// to their instructions. Connections between friends (contact.json "links": [{ id, relation }], set with
// `tools/contact.py link`) tell each one who the other is. News about the buddy only travels between connected
// friends after a call, filtered by the receiver's role (see passNews), and lands in
// data/contacts/<receiver>/heard-from/<sender>.md. A friend never sees another friend's raw memory notes.
const rolesDir = path.join(personasDir, "_roles");
const roleFile = (role) => (/^[a-z-]+$/.test(String(role || "")) ? path.join(rolesDir, `${role}.md`) : null);
const roleRules = (c) => {
  const file = roleFile(c.role);
  return file && fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
};
const heardFromPath = (receiverId, senderId) => path.join(contactsDir, receiverId, "heard-from", `${senderId}.md`);

function connectionNews(c) {
  return (c.links ?? []).map(({ id, relation }) => {
    const other = loadContact(id);
    if (!other) return "";
    const them = firstName(other);
    let heard = "";
    try { heard = fs.readFileSync(heardFromPath(c.id, id), "utf8").trim(); } catch {}
    return `\n\n# ${other.name}, ${relation}\n${other.name} is ${relation}. Your buddy talks with ${them} too, on separate calls. You weren't on those calls, and you only know what ${them} has passed along.\n` +
      (heard ? `What ${them} has told you about your buddy:\n${heard}` : `${them} hasn't passed along anything about your buddy yet.`);
  }).join("");
}

// After a call with `sender`, works out what news about the buddy would naturally reach each connected friend, given
// how they're connected and the receiver's role, and merges it into what that friend has heard.
async function passNews(sender, transcript) {
  for (const { id } of sender.links ?? []) {
    const receiver = loadContact(id);
    if (!receiver) continue;
    const relation = receiver.links?.find((l) => l.id === sender.id)?.relation ?? "a friend";
    const file = heardFromPath(receiver.id, sender.id);
    let before = "";
    try { before = fs.readFileSync(file, "utf8").trim(); } catch {}
    const s = firstName(sender), r = firstName(receiver);
    try {
      const msg = await getClient().messages.create({
        model: NEWS_MODEL,
        max_tokens: 4000,
        output_config: { effort: "low" },
        system:
          `You decide what news about a person (the "buddy") would naturally travel from one of their friends to another, the way people really talk. ` +
          `${sender.name} just had a phone call with the buddy. To ${receiver.name}, ${sender.name} is ${relation}. ` +
          `${receiver.name}'s role in the buddy's life:\n${roleRules(receiver) || "A friend."}\n\n` +
          `Update the notes of what ${r} has heard from ${s} about the buddy. Include only what ${s} would plausibly pass along to ${r}, given their connection and ${r}'s role. Phrase it the way ${r} would have heard it (like "${s} said Jason's been working long hours"), not as a transcript. ` +
          `Never include anything the buddy asked to keep private or said in confidence ("don't tell anyone", "between us", "keep this quiet"), or that ${r}'s role says they wouldn't hear. Don't include details ${s} made up about ${s}'s own life. ` +
          `Keep earlier notes unless they're stale or the newest call changed them. Write short plain-text bullet lines starting with '- ', at most 25 lines. Output only the notes. If there's nothing to pass along and no earlier notes, output exactly NONE.`,
        messages: [{ role: "user", content: `Earlier notes:\n${before || "(none)"}\n\nThe newest call between ${s} and the buddy:\n${transcript}` }],
      });
      const notes = msg.stop_reason === "refusal" ? "" : textOf(msg.content).trim();
      if (notes && notes !== "NONE") {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, notes + "\n");
      }
    } catch (err) {
      console.error(`Passing news from ${sender.id} to ${receiver.id} failed:`, err?.message ?? err);
    }
  }
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
    // Strip the hang-up marker as text streams in. It can arrive split across chunks, so hold back any ending
    // that could be the start of it.
    let held = "", hangingUp = false;
    const pass = (text) => {
      held += text;
      let i;
      while ((i = held.indexOf(HANGUP)) >= 0) {
        res.write(held.slice(0, i));
        held = held.slice(i + HANGUP.length);
        hangingUp = true;
      }
      let keep = 0;
      for (let k = Math.min(HANGUP.length - 1, held.length); k > 0; k--) {
        if (HANGUP.startsWith(held.slice(-k))) { keep = k; break; }
      }
      res.write(held.slice(0, held.length - keep));
      held = held.slice(held.length - keep);
    };
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") pass(event.delta.text);
    }
    res.write(held);
    if (hangingUp) res.write("\u0000HANGUP");
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
    .map((m) => `${m.role === "user" ? "Buddy" : first}: ${textOf(m.content).replaceAll(HANGUP, "").trim()}`)
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
  if (transcript.trim()) await passNews(c, transcript);
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
    // If Chatterbox is still loading (about 20 s after it starts), wait for it rather than failing the sentence.
    await chatterbox.start();
    for (let i = 0; i < 90 && !(await chatterbox.status()).ready; i++) await new Promise((r) => setTimeout(r, 1000));
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
      hasVoice: !!voiceFile(c.settings.cbVoice), callsYou: c.settings.callsYou ?? "never",
      active: c.active !== false, calls: c.memory.calls, lastCall: c.memory.lastCall,
    })));
  }
  const contactRoute = url.pathname.match(/^\/api\/contacts\/([a-z0-9-]+)$/);
  if (contactRoute) {
    const c = loadContact(contactRoute[1]);
    if (!c) return json(res, 404, { error: "No such friend." });
    if (req.method === "PUT") {
      const { settings = {}, active } = await readBody(req);
      for (const k of SETTING_KEYS) if (k in settings) c.settings[k] = settings[k];
      // Inactive friends are hidden from the friends list and never call you; nothing else about them changes.
      if (typeof active === "boolean") c.active = active;
      if (c.settings.model && !MODELS[c.settings.model]) c.settings.model = DEFAULT_MODEL;
      if (Object.keys(settings).length) delete c.legacy;
      saveContact(c);
    }
    return json(res, 200, {
      id: c.id, name: c.name, firstName: firstName(c), settings: c.settings, legacy: !!c.legacy,
      active: c.active !== false, calls: c.memory.calls, lastCall: c.memory.lastCall,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    if (!getClient()) return json(res, 400, { error: "No API key yet." });
    const { contact: contactId, incoming } = await readBody(req);
    const c = loadContact(contactId);
    if (!c) return json(res, 400, { error: "No such friend." });
    if (call) await hangUp();
    call = {
      contactId: c.id,
      started: new Date(),
      system: systemPrompt(c),
      messages: [{
        role: "user",
        content: incoming
          // They rang the buddy (a random incoming call), so they speak first and say why they called.
          ? "(You called your buddy, and they just picked up. Say hello and why you called, the way you would.)"
          : "(Your phone rings. It's your buddy calling. Pick up and answer the way you would.)",
      }],
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
