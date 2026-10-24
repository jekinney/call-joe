// Call Joe server: serves the call page, keeps each friend's persona and memory, and talks to Claude.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import zlib from "node:zlib";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createKnowledge } from "./knowledge.mjs";
import { createGeminiClient } from "./gemini.mjs";
import { createGrokClient, pickGrokModels } from "./grok.mjs";
import { stateAt, describeState, replyDelayMs, answersCall, canReachOut, cleanSchedule, scheduleText } from "./availability.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
// CALLJOE_DATA and CALLJOE_PORT let a test copy run beside the real one without touching your data.
const dataDir = process.env.CALLJOE_DATA || path.join(dir, "data");
fs.mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.CALLJOE_PORT) || 5174;
// Models a friend can think with. Thinking is kept as low as each model allows so they answer quickly.
// Claude's need the Anthropic key; Gemini's need the Google AI key; Grok's need the xAI key. Each has a twin (same
// tier), used when the chosen one's key is missing or not working. Grok's ids are the newest ones the xAI key offers.
const MODELS = {
  haiku: {
    id: "claude-haiku-5-5", label: "Haiku: fastest and cheapest", twin: "gemini-flash-lite",
    params: { thinking: { type: "disabled" } },
  },
  sonnet: {
    id: "claude-sonnet-5-5", label: "Sonnet: quick and sharp (recommended)", twin: "gemini-flash",
    params: { thinking: { type: "between_tools" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
  },
  opus: {
    id: "claude-opus-5-5", label: "Opus: deepest, but slower and pricier", twin: "gemini-argon",
    params: { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
  },
  "gemini-flash-lite": { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite: fastest and cheapest", twin: "haiku", google: true, params: {} },
  "gemini-flash": { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash: quick and sharp", twin: "sonnet", google: true, params: {} },
  "gemini-argon": { id: "gemini-4-argon", label: "Gemini 4 Argon: deepest, but slower and pricier", twin: "opus", google: true, params: {} },
  "grok-fast": { get id() { return grokModels().fast; }, get label() { return `Grok fast (${this.id}): quickest`; }, twin: "haiku", grok: true, params: {} },
  grok: { get id() { return grokModels().main; }, get label() { return `Grok (${this.id}): smartest`; }, twin: "sonnet", grok: true, params: {} },
};
// The newest Grok chat models the xAI key offers (checked with the keys, below).
const grokModels = () => {
  const found = pickGrokModels(brains.grok?.ids ?? []);
  return { main: found.main ?? "grok-4.7", fast: found.fast ?? found.main ?? "grok-4.7" };
};
const providerOf = (m) => (m.google ? "google" : m.grok ? "grok" : "claude");
const KEY_OF = { claude: "apiKey", google: "googleKey", grok: "xaiKey" };
const DEFAULT_MODEL = "sonnet";
const MEMORY_MODEL = "claude-opus-5-5"; // writes each friend's notes after each call
const NEWS_MODEL = "claude-haiku-5-5"; // decides what news travels between connected friends (one small call each)
const IDLE_SHUTDOWN_MS = 3 * 60 * 1000;

const configFile = path.join(dataDir, "config.json");
const recentsFile = path.join(dataDir, "recents.json"); // when you last cleared Recents: { cleared: { incoming, outgoing } }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

let config = readJson(configFile, {});
let client = null;
let call = null; // { contactId, system, messages, started }
let held = null; // a call on hold while you answer another line (call waiting); same shape as call
let lastPing = Date.now();

// ---- Python helpers on the graphics card, started on demand: Chatterbox (voice cloning) and Ditto (talking face) ----
// Each one quits by itself about 30 seconds after this server stops answering /api/alive.
function pythonHelper(name, folder, script, port, venv = folder) {
  const python = path.join(dir, venv, ".venv", "Scripts", "python.exe");
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
const pictureEngine = pythonHelper("pictures", "pictures", "picture_server.py", 5177, "voice"); // shares the voice engine's Python

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
// callsYou: how often this friend rings you while the app is open; textsYou: how often they text you first. One list
// each, used by the Edit menus, the call and text schedules in the page (odds per minute the app is open, and a scale
// on their usual texts per day), the friend's own prompt (reachingOut), Support, and learning from calls.
const CALL_FREQ = {
  never: { label: "Never (you always call)", odds: 0, says: "You don't usually call your buddy on your own; you've been leaving the calling to them. If they ask you to call them, that's fine: just agree, the way a friend would." },
  rarely: { label: "Rarely (every few days)", odds: 1 / 1440, says: "You call your buddy only once in a while, every few days." },
  daily: { label: "About once a day", odds: 1 / 480, says: "You call your buddy about once a day." },
  sometimes: { label: "Now and then (every few hours)", odds: 1 / 180, says: "You call your buddy now and then, every few hours." },
  often: { label: "Often (about once an hour)", odds: 1 / 60, says: "You call your buddy often, about once an hour." },
  constantly: { label: "Constantly (a few times an hour)", odds: 1 / 20, says: "You call your buddy constantly, a few times an hour. You can't help yourself." },
};
const TEXT_FREQ = {
  never: { label: "Never (only texts back)", scale: 0, says: "You don't text your buddy first; you text back when they text you." },
  rarely: { label: "Rarely", scale: 0.3, says: "You rarely text your buddy first." },
  less: { label: "Less than usual", scale: 0.6, says: "You text your buddy first a little less than you naturally would." },
  sometimes: { label: "Their usual (depends on who they are to you)", scale: 1, says: "" },
  more: { label: "More than usual", scale: 1.5, says: "You text your buddy first a bit more than you naturally would." },
  often: { label: "Often (about twice as much)", scale: 2, says: "You text your buddy first a lot, about twice as much as you naturally would." },
  constantly: { label: "Constantly (about three times as much)", scale: 3, says: "You text your buddy all the time, about three times as much as you naturally would." },
};
const CALLS_YOU = Object.keys(CALL_FREQ);
const TEXTS_YOU = Object.keys(TEXT_FREQ);
const callsYouOf = (c) => (CALL_FREQ[c.settings.callsYou] ? c.settings.callsYou : "never");
const textsYouOf = (c) => (TEXT_FREQ[c.settings.textsYou] ? c.settings.textsYou : "sometimes");
// How often they reach out, in their own prompt, so what they say matches (no "I'll call you tomorrow" when they never call).
const reachingOut = (c) => `# How often you reach out\n${CALL_FREQ[callsYouOf(c)].says} ${TEXT_FREQ[textsYouOf(c)].says} Keep what you say about calling and texting consistent with this, in character.`.trim();
const SETTING_KEYS = ["model", "cbVoice", "face", "callsYou", "textsYou"];

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

// Friends only; the support agents (contact.json "support": true) live alongside them but stay out of every list.
const listAll = () => fs.readdirSync(contactsDir).map(loadContact).filter(Boolean);
const listSupport = () => listAll().filter((c) => c.support);
const listContacts = () =>
  listAll().filter((c) => !c.support)
    .sort((a, b) => (a.id === "joe" ? -1 : b.id === "joe" ? 1 : a.name.localeCompare(b.name)));

// One-time move from the single-friend layout (data/memory.json, data/call-log.txt) into data/contacts/joe/.
// The old files are copied to data/backup-before-contacts/ first. Joe's notes and log move over unchanged.
function moveJoeIntoContacts() {
  const oldMemory = path.join(dataDir, "memory.json");
  if (fs.existsSync(contactPath("joe", "contact.json")) || !fs.existsSync(oldMemory)) return;
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
// The support line is part of the phone: any support agent in contacts/support-*/ that isn't installed gets installed.
function installSupport() {
  for (const id of fs.readdirSync(personasDir)) {
    if (catalogEntry(id)?.support && !loadContact(id)) {
      try { installFriend(id, "friend"); } catch (err) { console.error(`Installing ${id} failed:`, err.message); }
    }
  }
}
setTimeout(installSupport, 0);

// A phone that was in use before first-time setup existed counts as set up (fill in "You" in Settings later).
if (config.setupDone === undefined) {
  config.setupDone = !!config.apiKey || fs.readdirSync(contactsDir).length > 0;
  writeJson(configFile, config);
}

// Live facts for friends who follow a team or have a hometown (see knowledge.mjs); refreshed while the app is open.
const knowledge = createKnowledge(dataDir);
knowledge.startRefreshing(() => (config.airplane ? [] : listContacts()));

// Your API key is never deleted by anything except you (Settings -> Account -> Remove key, only in airplane mode).
// Airplane mode (config.airplane) turns the key off: no calls, no friends calling, no news, no live-knowledge
// updates. Everything already saved stays on this computer.
// With no Claude key, or one that's stopped working, a Google AI key stands in: Gemini thinks (gemini.mjs).
let geminiClient = null;
function getClient() {
  if (config.airplane) return null;
  if (config.apiKey && !(brains.claude?.ok === false && brains.google?.ok)) return (client ??= new Anthropic({ apiKey: config.apiKey }));
  if (config.googleKey) return (geminiClient ??= createGeminiClient(() => config.googleKey));
  return null;
}

// Which keys work, and which of the models above each one can use. Checked when the app starts, when a key is saved,
// and every half hour. null = not checked yet (a saved key counts as working until then).
const brains = { claude: null, google: null, grok: null }; // { ok, why, ids: Set, at }
async function checkBrains() {
  const check = async (has, list) => {
    if (!has) return null;
    try { return { ok: true, ids: new Set(await list()), at: Date.now() }; }
    catch (err) {
      const why = err?.status === 401 || err?.status === 403 ? "it wasn't accepted (it may have been turned off or deleted)"
        : err?.status === 429 ? "it's over its limit for now" : String(err?.message ?? err).slice(0, 160);
      return { ok: false, why, ids: new Set(), at: Date.now() };
    }
  };
  [brains.claude, brains.google, brains.grok] = await Promise.all([
    check(config.apiKey, async () => {
      const ids = [];
      for await (const m of new Anthropic({ apiKey: config.apiKey }).models.list({ limit: 100 })) ids.push(m.id);
      return ids;
    }),
    check(config.googleKey, async () => {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": config.googleKey }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw Object.assign(new Error(`Google answered ${r.status}.`), { status: r.status === 400 ? 401 : r.status });
      return ((await r.json()).models ?? []).map((m) => m.name.replace(/^models\//, ""));
    }),
    check(config.xaiKey, async () => {
      const r = await fetch("https://api.x.ai/v1/models", { headers: { Authorization: `Bearer ${config.xaiKey}` }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw Object.assign(new Error(`xAI answered ${r.status}.`), { status: r.status === 400 ? 401 : r.status });
      return ((await r.json()).data ?? []).map((m) => m.id);
    }),
  ]);
}
setTimeout(() => checkBrains().catch(() => {}), 0);
setInterval(() => checkBrains().catch(() => {}), 30 * 60 * 1000);
// Can this model think right now?
function modelUsable(key) {
  const m = MODELS[key];
  if (!m || config.airplane) return false;
  const prov = providerOf(m);
  const b = brains[prov];
  if (!config[KEY_OF[prov]]) return false;
  return !b || (b.ok && b.ids.has(m.id));
}
let grokClient = null;
const getGrok = () => (grokClient ??= createGrokClient(() => config.xaiKey, (id = "") => (/^grok/.test(id) ? id : /haiku|lite/.test(id) ? grokModels().fast : grokModels().main)));
// The friend's chosen model if it can think right now; otherwise its twin, then any that can.
// Rated R flirting switches them to Grok, at the same tier (fast picks stay fast).
function chatModel(c) {
  let want = MODELS[c?.settings.model] ? c.settings.model : DEFAULT_MODEL;
  if (c && flirtingOf(c) === "rated-r" && !MODELS[want].grok) want = ["haiku", "gemini-flash-lite"].includes(want) ? "grok-fast" : "grok";
  const key = [want, MODELS[want].twin, DEFAULT_MODEL, MODELS[DEFAULT_MODEL].twin, ...Object.keys(MODELS)].find(modelUsable) ?? want;
  const m = MODELS[key];
  const cl = config.airplane ? null
    : m.google ? (config.googleKey ? (geminiClient ??= createGeminiClient(() => config.googleKey)) : null)
      : m.grok ? (config.xaiKey ? getGrok() : null)
        : config.apiKey ? (client ??= new Anthropic({ apiKey: config.apiKey })) : null;
  return { ...m, key, client: cl ?? getClient() };
}

// Built once per call and left unchanged during it, so the prompt cache keeps hitting. A friend with no role,
// connections or knowledge settings (like Joe) gets exactly the persona, ending-the-call, memory and time sections.
// Saves your profile from the Settings -> You form or a support call (see the comments inside on what's kept).
function saveProfileFrom(b) {
  const clean = (v) => String(v ?? "").trim().slice(0, 80);
  const before = yourGender();
  const age = (v) => { const n = Math.round(Number(v)); return n >= 13 && n <= 120 ? n : null; };
  const md = (v) => (/^\d{2}-\d{2}$/.test(String(v ?? "")) ? v : "");
  // What you and your spouse told the phone, and what friends learned, only ever goes away with a factory reset.
  // Saving merges: a blank field keeps what was there. "Not married" just stops friends bringing them up; their
  // notes and dates are kept in case you switch it back.
  const prev = config.user ?? {};
  const keep = (v, was) => (clean(v) || was || "");
  // Ages are saved with the year they were given (a year older each year after). An unchanged age keeps its year.
  const ageOf = (v, p) => { const n = age(v); return n === null ? { age: p?.age ?? null, ageYear: p?.ageYear } : n === ageNow(p) ? { age: p.age, ageYear: p.ageYear } : { age: n, ageYear: new Date().getFullYear() }; };
  const old = prev.spouse;
  let spouse = old;
  if (b.spouse?.married === false && old) spouse = { ...old, married: false };
  else if (b.spouse?.name) {
    spouse = {
      ...(old ?? {}), married: true,
      name: clean(b.spouse.name), gender: b.spouse.gender === "man" ? "man" : "woman",
      birthday: md(b.spouse.birthday) || old?.birthday || "", anniversary: md(b.spouse.anniversary) || old?.anniversary || "",
      about: String(b.spouse.about ?? "").trim().slice(0, 2000) || old?.about || "", ...ageOf(b.spouse.age, old),
      notes: old?.notes ?? "", dates: old?.dates ?? [], reminded: old?.reminded ?? {},
    };
  }
  // Family, pets and notes come whole from the Settings -> You form (or a support call).
  const person = (f) => ({
    name: clean(f?.name), relation: clean(f?.relation), gender: f?.gender === "man" ? "man" : f?.gender === "woman" ? "woman" : "",
    age: age(f?.age), birthday: md(f?.birthday), lives: clean(f?.lives), notes: String(f?.notes ?? "").trim().slice(0, 1000),
  });
  const lists = {
    ...(Array.isArray(b.family) ? { family: b.family.map(person).filter((f) => f.name) } : {}),
    ...(Array.isArray(b.pets) ? { pets: b.pets.map((x) => ({ name: clean(x?.name), kind: clean(x?.kind), notes: String(x?.notes ?? "").trim().slice(0, 500) })).filter((x) => x.name) } : {}),
    ...(typeof b.notes === "string" ? { notes: b.notes.trim().slice(0, 3000) } : {}),
    ...(typeof b.avoid === "string" ? { avoid: b.avoid.trim().slice(0, 2000) } : {}),
  };
  config.user = { ...prev, ...lists, first: keep(b.first, prev.first), last: keep(b.last, prev.last),
    gender: b.gender === "woman" ? "woman" : b.gender === "man" ? "man" : prev.gender ?? "man", home: keep(b.home, prev.home),
    ...ageOf(b.age, prev), birthday: md(b.birthday) || prev.birthday || "", greeted: prev.greeted ?? {},
    ...(spouse ? { spouse } : {}) };
  // Switching between man and woman moves friends still on their default relationship to the default for the other.
  if (yourGender() !== before) {
    for (const c of listContacts()) {
      const f = catalogEntry(c.id);
      // Only friends you haven't talked to yet switch defaults; after that, family stays family.
      if (f?.roles && !hasTalked(c) && c.role === resolveRole(f.roles[before], f.gender)) c.role = f.roles[yourGender()];
      c.role = resolveRole(shownRole(c.role), friendGender(c));
      saveContact(c);
    }
  }
  writeJson(configFile, config);
}

// ---- Becoming official: one merged identity per friend ----
// A friend becomes official at your first call or text. Then their persona and their relationship to you are merged
// once (by Opus) into one tight identity, saved in data/contacts/<id>/identity.md and reused on every call and text: a
// shorter, steadier prompt that caches well. The phone-call and safety rules are kept word for word, not merged.
// It's rebuilt only when the persona, the relationship or your gender changes. What they learn about you (memory
// notes, rules, news) stays separate and is added fresh to each call.
const PHONE_RULES_HEADING = "## How you talk on the phone";
function identitySource(c) {
  const persona = fs.readFileSync(path.join(personasDir, c.id, "persona.md"), "utf8");
  const i = persona.indexOf(PHONE_RULES_HEADING);
  const character = (i >= 0 ? persona.slice(0, i) : persona).trim();
  const rules = i >= 0 ? persona.slice(i).trim() : "";
  const role = roleRules(c);
  const hash = crypto.createHash("sha1").update(`${character}\n${role}\n${yourGender()}`).digest("hex").slice(0, 16);
  return { character, rules, role, hash };
}
const identityFile = (id) => contactPath(id, "identity.md");
function identityReady(c) {
  return c.identity?.hash === identitySource(c).hash && fs.existsSync(identityFile(c.id));
}
// Identities are built when a friend is installed (the "Creating…" screen, the only time you see it), and rebuilt
// after a persona, relationship or gender change in the background. Until the new one is ready, the friend talks from
// their persona and relationship as written (systemPrompt's fallback), so a call or text never waits.
const buildingIdentity = new Set();
function refreshIdentity(c) {
  if (!c || c.support || buildingIdentity.has(c.id) || identityReady(c) || !getClient()) return;
  buildingIdentity.add(c.id);
  buildIdentity(c)
    .then(() => console.log(`${c.name}'s identity is ready`))
    .catch((err) => console.error(`Building ${c.name}'s identity failed:`, err?.message ?? err))
    .finally(() => buildingIdentity.delete(c.id));
}
// At startup, friends whose persona changed while the app was closed (tools/contact.py persona) get rebuilt.
setTimeout(() => { for (const c of listContacts()) if (c.identity) refreshIdentity(c); }, 5000);

async function buildIdentity(c) {
  const src = identitySource(c);
  const msg = await getClient().messages.create({
    model: MEMORY_MODEL,
    max_tokens: 6000,
    output_config: { effort: "low" },
    system:
      `You write the character instructions for ${c.name}, an AI friend in a phone app. Merge the character description and how they relate to the person they talk to ("your buddy", who is ${yourGender() === "woman" ? "a woman" : "a man"}) into one tight, second-person prompt. ` +
      `Keep every concrete fact (names, ages, places, family, job, pets, phrases, beliefs) and their voice; keep the rules about what news would and wouldn't reach them and what they do when the buddy doesn't answer. Where the two disagree about who they are to the buddy, the relationship wins. ` +
      `Cut repetition and filler. Use short Markdown headings and bullets, starting with "# Who you are". Output only the prompt.`,
    messages: [{ role: "user", content: `Character description:\n${src.character}\n\nTheir relationship to the buddy:\n${src.role || "A friend."}` }],
  });
  const text = msg.stop_reason === "refusal" ? "" : textOf(msg.content).trim();
  if (!text.startsWith("#")) throw new Error("Couldn't put their personality together.");
  fs.writeFileSync(identityFile(c.id), `${text}\n`);
  const fresh = loadContact(c.id);
  fresh.identity = { hash: src.hash, at: new Date().toISOString() };
  saveContact(fresh);
}

// ---- The support line ----
// A few agents answer at random (contacts/support-*/). They keep no memory of callers. What they share: your profile
// (config.user: you, spouse, family, pets, dates, notes), the help guide (contacts/_support/help.md), and notes from
// earlier support calls about the app (data/support-notes.md). After a call, what you confirmed updates your profile,
// with a dated copy of the old one in data/profile-history/. They can change some settings for you by voice.
const supportFile = (name) => path.join(personasDir, "_support", name);
const supportNotesFile = path.join(dataDir, "support-notes.md");
function profileText() {
  const u = config.user ?? {};
  const lines = [];
  const add = (k, v) => v && lines.push(`- ${k}: ${v}`);
  add("Name", [u.first, u.last].filter(Boolean).join(" "));
  add("Gender", u.gender);
  add("Age", ageNow(u));
  add("Birthday", u.birthday && dayName(u.birthday));
  add("Lives in", u.home);
  const sp = u.spouse;
  if (sp?.name) add(sp.married === false ? "Former spouse (not married now)" : "Spouse", `${sp.name} (${sp.gender}${ageNow(sp) ? `, ${ageNow(sp)}` : ""}${sp.birthday ? `, birthday ${dayName(sp.birthday)}` : ""}${sp.anniversary ? `, anniversary ${dayName(sp.anniversary)}` : ""})${sp.about ? `: ${sp.about}` : ""}`);
  for (const f of u.family ?? []) add(f.relation || "Family", `${f.name}${f.age ? `, ${f.age}` : ""}${f.birthday ? `, birthday ${dayName(f.birthday)}` : ""}${f.lives ? `, lives in ${f.lives}` : ""}${f.notes ? `: ${f.notes}` : ""}`);
  for (const pet of u.pets ?? []) add("Pet", `${pet.name}${pet.kind ? ` (${pet.kind})` : ""}${pet.notes ? `: ${pet.notes}` : ""}`);
  add("Other things friends should know", u.notes);
  add("Never bring up", u.avoid);
  return lines.join("\n") || "(Empty. This may be a brand-new caller: start with their name.)";
}
function supportPrompt(c) {
  const read = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };
  const now = new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const friends = listContacts().map((f) => `- ${f.name}: your caller's ${shownRole(f.role ?? "friend").replace("-", " ")}, calls them ${f.settings.callsYou ?? "never"}, texts them ${f.settings.textsYou ?? "sometimes"}${f.active === false ? ", turned off" : ""}`).join("\n");
  return [
    fs.readFileSync(path.join(personasDir, c.id, "persona.md"), "utf8").trim(),
    read(supportFile("support-rules.md")),
    `# The caller's profile (shared by every agent)\n${profileText()}`,
    `# Their friends in the app\n${friends || "(None installed.)"}`,
    read(supportFile("help.md")),
    `# Texting\nYour caller may text you in Messages ("Support"). Commands start with /, and /help lists them:\n${SUPPORT_HELP}`,
    read(supportNotesFile) && `# Notes from earlier support calls\n${read(supportNotesFile)}`,
    ENDING_THE_CALL,
    `# Right now\nIt's ${now}. Airplane mode is ${config.airplane ? "on" : "off"}.`,
  ].filter(Boolean).join("\n\n");
}

// Settings support agents can change by voice.
const SUPPORT_TOOLS = [{
  name: "change_setting",
  description: `Change a setting for the caller, after they agree. friend settings: callsYou (${CALLS_YOU.join(", ")}), textsYou (${TEXTS_YOU.join(", ")}), active (true or false), role (a relationship like best-friend, close-friend, friend, distant-friend). Phone settings: airplane (true or false), silent (true or false: calls and texts come in without a sound).`,
  input_schema: {
    type: "object",
    properties: {
      friend: { type: "string", description: "The friend's first name, or empty for a phone setting." },
      setting: { type: "string", enum: ["callsYou", "textsYou", "active", "role", "airplane", "silent"] },
      value: { type: "string" },
    },
    required: ["setting", "value"],
  },
}];
async function runSupportTool(name, input) {
  if (name !== "change_setting") throw new Error("Unknown tool.");
  const { friend, setting, value } = input ?? {};
  if (setting === "airplane") {
    config.airplane = value === "true";
    writeJson(configFile, config);
    return `Airplane mode is now ${config.airplane ? "on" : "off"}.`;
  }
  if (setting === "silent") {
    if (value === "true") config.silent = true;
    else delete config.silent;
    writeJson(configFile, config);
    return `Silent mode is now ${config.silent ? "on" : "off"}.`;
  }
  const c = listContacts().find((f) => firstName(f).toLowerCase() === String(friend ?? "").trim().toLowerCase().split(" ")[0]);
  if (!c) return `There's no friend called ${friend}.`;
  if (setting === "callsYou" && CALLS_YOU.includes(value)) c.settings.callsYou = value;
  else if (setting === "textsYou" && TEXTS_YOU.includes(value)) c.settings.textsYou = value;
  else if (setting === "active") c.active = value === "true";
  else if (setting === "role") {
    if (!roleChoicesFor(friendGender(c), c.role ?? "friend", hasTalked(c)).includes(value)) return `${c.name} can't become their ${value}: family is locked after the first call, and friends can only move between kinds of friends.`;
    c.role = resolveRole(value, friendGender(c));
  } else return "That value doesn't work for that setting.";
  saveContact(c);
  addNotice(`Support changed ${firstName(c)}'s ${{ callsYou: "calling", textsYou: "texting", active: "on/off", role: "relationship" }[setting]} setting to ${value}.`, c.id);
  return `Done: ${c.name}'s ${setting} is now ${value}.`;
}

// After a support call: update the profile from what was confirmed, and keep any app tips for the other agents.
async function afterSupportCall(transcript) {
  const u = config.user ?? {};
  const current = JSON.stringify({
    first: u.first, last: u.last, gender: u.gender, age: ageNow(u), birthday: u.birthday, home: u.home,
    spouse: u.spouse ? { name: u.spouse.name, gender: u.spouse.gender, married: u.spouse.married !== false, age: ageNow(u.spouse), birthday: u.spouse.birthday, anniversary: u.spouse.anniversary, about: u.spouse.about } : null,
    family: u.family ?? [], pets: u.pets ?? [], notes: u.notes ?? "", avoid: u.avoid ?? "",
  });
  try {
    const msg = await getClient().messages.create({
      model: MEMORY_MODEL,
      max_tokens: 8000,
      output_config: { effort: "low" },
      system:
        "You update a person's profile from a call they made to a support line. Apply only what the caller stated or confirmed; keep everything else as it is. " +
        "Dates are MM-DD. family entries: {name, relation (like daughter, son, mother, brother, grandson), gender (man or woman), age (number or null), birthday (MM-DD or empty), lives (town), notes}. pets: {name, kind, notes}. " +
        "notes: other things their friends should know. avoid: things friends should never bring up. supportNotes: a line or two about any app problem or how-to that came up and how it was solved, useful to other agents, or empty. " +
        'Answer with JSON only: {"profile": {same shape as the input}, "supportNotes": "..."}.',
      messages: [{ role: "user", content: `Current profile:\n${current}\n\nThe support call:\n${transcript}` }],
    });
    if (msg.stop_reason === "refusal") return;
    const out = JSON.parse(textOf(msg.content).replace(/^```(json)?|```$/gm, "").trim());
    const pr = out.profile;
    if (pr && typeof pr === "object") {
      fs.mkdirSync(path.join(dataDir, "profile-history"), { recursive: true });
      writeJson(path.join(dataDir, "profile-history", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), config.user ?? {});
      saveProfileFrom(pr);
    }
    if (typeof out.supportNotes === "string" && out.supportNotes.trim()) {
      let notes = "";
      try { notes = fs.readFileSync(supportNotesFile, "utf8"); } catch {}
      const lines = `${notes}- ${new Date().toLocaleDateString()}: ${out.supportNotes.trim()}\n`.trim().split("\n").slice(-40);
      fs.writeFileSync(supportNotesFile, lines.join("\n") + "\n");
    }
  } catch (err) {
    console.error("Profile update failed:", err?.message ?? err);
  }
}

// Cussing: off unless you allow it for this friend (when installing, or in their ✎ Edit). contacts/_language/.
const languageRules = (c) => {
  try { return fs.readFileSync(path.join(personasDir, "_language", c.cussing ? "cussing.md" : "clean.md"), "utf8").trim(); } catch { return ""; }
};

// Flirting: off unless you set it (✎ Edit), except a romantic interest, who flirts romantically by default. Up to
// Romantic it's PG-13: contacts/_flirting/ keeps it suggestive, never explicit. Rated R (contacts/_flirting/rated-r.md)
// is adults-only and frank, and only with a working xAI key: the friend thinks with Grok then (chatModel). It's only
// for friends and partners, never family; without Grok it falls back to Romantic.
const FLIRTING = ["off", "playful", "romantic", "rated-r"];
const R_ROLES = new Set(["best-friend", "close-friend", "friend", "distant-friend", "family-friend", "neighbor", "coworker", "romantic-interest", "spouse", "girlfriend-bestie"]);
const ratedROk = (c) => R_ROLES.has(c.role ?? "friend") && (modelUsable("grok") || modelUsable("grok-fast"));
const flirtingOf = (c) => (c.flirting === "rated-r" ? (ratedROk(c) ? "rated-r" : "romantic")
  : FLIRTING.includes(c.flirting) ? c.flirting : c.role === "romantic-interest" ? "romantic" : "off");
// Spicy pictures and videos (✎ Edit, off by default): only with Rated R on. They're made by Grok Imagine and show only
// the friend, an adult; see spicyMedia below.
const spicyOn = (c) => !!c.spicyMedia && flirtingOf(c) === "rated-r";
const flirtingRules = (c) => {
  const level = flirtingOf(c);
  if (level === "off") return "";
  try { return fs.readFileSync(path.join(personasDir, "_flirting", `${level}.md`), "utf8").trim(); } catch { return ""; }
};

// A friend who mixes in another language (contact.json "speaks", like "es"; tools/contact.py speaks) wraps those
// words in tags, so Chatterbox's multilingual model says them with a real accent (voice/chatterbox_server.py).
// Tags are stripped from everything you see: captions, texts, voicemail transcripts and memory.
const LANGS = { es: "Spanish", fr: "French", it: "Italian", de: "German", pt: "Portuguese" };
const LANG_TAGS = /<\/?[a-z]{2}>/g;
const untag = (t) => t.replaceAll(HANGUP, "").replace(LANG_TAGS, "");
const speaksRules = (c) => {
  const lang = LANGS[c.speaks];
  if (!lang) return "";
  const t = c.speaks;
  const example = t === "es" ? ` Like: "<es>¡Ay, Dios mío!</es> You won't believe it, <es>mijo</es>. <es>Gracias a Dios</es> it's Friday."` : "";
  return `# Speaking ${lang}
Whenever you say a word or phrase in ${lang}, wrap it in <${t}>…</${t}> so your voice pronounces it right. That includes single words and nicknames, every time.${example} Wrap only the ${lang} words, never English ones, and spell them properly with their accents. The tags are a signal for your voice, not something you say, and your buddy never sees them.`;
};
// Loads the multilingual voice in the background when a call with such a friend starts, so their first words aren't held up.
async function warmLanguages(c) {
  if (!LANGS[c.speaks]) return;
  await chatterbox.start();
  for (let i = 0; i < 30; i++) {
    if (await fetch(`${chatterbox.url}/warm`, { method: "POST" }).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function systemPrompt(c) {
  if (c.support) return supportPrompt(c);
  // Official friends use their merged identity; until then, the persona and relationship as written.
  const src = identitySource(c);
  const persona = identityReady(c) ? `${fs.readFileSync(identityFile(c.id), "utf8").trim()}\n\n${src.rules}` : null;
  if (!persona) refreshIdentity(c); // ready for next time; this time they use the persona as written
  const memory = c.memory;
  const now = new Date().toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const mem = memory.notes
    ? `What you remember about your buddy from past calls:\n${memory.notes}`
    : config.user?.first
      ? "This is your first phone call in a long while. You know who your buddy is, but you're behind on what's going on in their life lately, so catch up."
      : "This is the first time this buddy has ever called you. You don't know their name or anything about them yet.";
  const last = memory.lastCall ? `Your last call with them was ${memory.lastCall}.` : "";
  return [
    ...(persona ? [persona.trimEnd()] : [`${src.character}\n\n${src.rules}`.trim(), src.role]),
    aboutBuddy(c),
    treatment(c),
    houseRules(),
    languageRules(c),
    flirtingRules(c),
    speaksRules(c),
    reachingOut(c),
    missedCalls(c),
    ENDING_THE_CALL,
    knowledge.tools(c).length ? LOOKING_THINGS_UP : "",
    `# Memory\n${mem}${connectionNews(c)}${voicemailsLeft(c)}${recentTexts(c)}`,
    await knowledge.briefing(c, config.user?.home),
    `# Right now\nIt's ${now} where you both live. ${last} Right now you're ${nowLine(c)}${nowFor(c).what === "free" ? "" : ", so keep it in mind (on a break, in a hurry, just woke up)"}.`,
  ].filter(Boolean).join("\n\n");
}

// ---- When friends are free (availability.mjs) ----
// Each friend has a day: asleep, at work, lunch, practices... (contact.json "schedule", drafted once by Claude from
// their persona; change it by texting Support "/Elena schedule ..."). It decides whether they pick up, how long a text
// reply takes (your texts wait in data/contacts/<id>/pending.json until then), and when they reach out. Your own
// hours (config.user.hours, "/quiet" and "/work") keep them from calling at bad times, and data/activity.json learns
// which hours you usually text and answer, so they reach out more then.
const scheduleOf = (c) => c.schedule ?? catalogEntry(c.id)?.schedule ?? null;
const nowFor = (c) => stateAt(scheduleOf(c));
const nowLine = (c) => describeState(nowFor(c), scheduleOf(c)?.tz);

async function draftSchedule(c) {
  let persona = "";
  try { persona = fs.readFileSync(path.join(personasDir, c.id, "persona.md"), "utf8").split(PHONE_RULES_HEADING)[0].slice(0, 4000); } catch {}
  const out = await askJson([{ type: "text", text: `${persona || c.name}

Write ${c.name}'s typical weekly routine as time blocks, for a phone app that decides when they can answer calls and texts. Include sleep, work or school hours and what that job allows (a nurse or teacher can't use the phone on shift, an office worker can text but not take calls, a stay-at-home parent is busy at school pickup and practices), lunch, regular commitments (church, gym, kids' activities), and anything from the description above. 24-hour times. A later block overrides an earlier one where they overlap, so list lunch after work.
Reply with only JSON: {"textStyle": "devoted" | "fast" | "normal" | "slow" (how quickly they usually text back; "devoted" for someone head over heels in love with your buddy), "blocks": [{"what": "asleep", "days": "daily" | "weekdays" | "weekends" | "mon,wed", "from": "22:30", "to": "06:00", "calls": "yes" | "rare" | "no", "texts": "fast" | "normal" | "slow" | "none"}]}` }], MEMORY_MODEL);
  return cleanSchedule(out);
}
// Friends without a schedule get one drafted (at startup and hourly, so newly installed friends get one too).
async function ensureSchedules() {
  if (!getClient()) return;
  for (const c of listContacts()) {
    if (scheduleOf(c)) continue;
    const schedule = await draftSchedule(c).catch(() => null);
    if (!schedule?.blocks.length) continue;
    const fresh = loadContact(c.id);
    fresh.schedule = schedule;
    saveContact(fresh);
    console.log(`Drafted ${c.name}'s schedule`);
  }
}
setTimeout(() => ensureSchedules().catch(() => {}), 8000);
setInterval(() => ensureSchedules().catch(() => {}), 60 * 60 * 1000);

async function reviseSchedule(c, change) {
  const out = await askJson([{ type: "text", text: `${c.name}'s current weekly routine (JSON):
${JSON.stringify(scheduleOf(c) ?? { textStyle: "normal", blocks: [] })}

The change: ${change}

Apply the change, keep everything else, same JSON shape (a later block overrides an earlier one). Reply with only the JSON.` }], MEMORY_MODEL);
  return cleanSchedule(out);
}

// Your hours. Defaults to quiet 9 PM to 8 AM, like before.
function userSchedule() {
  const h = config.user?.hours ?? {};
  return { blocks: [
    ...(h.work?.from && h.work?.to ? [{ what: "work", days: h.work.days ?? "weekdays", from: h.work.from, to: h.work.to, calls: "no", texts: "normal" }] : []),
    { what: "quiet", days: "daily", from: h.quiet?.from ?? "21:00", to: h.quiet?.to ?? "08:00", calls: "no", texts: "none" },
  ] };
}
const userBusy = () => { const st = stateAt(userSchedule()); return st.what === "free" ? null : st.what; };

// Which hours you're usually around (texting, calling, answering), so friends reach out more then.
const activityFile = path.join(dataDir, "activity.json");
function noteActivity() {
  const a = readJson(activityFile, { hours: Array(24).fill(0) });
  a.hours[new Date().getHours()] += 1;
  if (a.hours.reduce((x, y) => x + y, 0) > 600) a.hours = a.hours.map((n) => n / 2); // old habits fade
  writeJson(activityFile, a);
}
function activityFactor(hour = new Date().getHours()) {
  const h = readJson(activityFile, { hours: Array(24).fill(0) }).hours;
  const total = h.reduce((x, y) => x + y, 0);
  if (total < 30) return 1; // not enough to go on yet
  const active = h.filter((n) => n > 0).length || 1;
  return Math.min(2, Math.max(0.3, h[hour] / (total / active)));
}

// Replies and follow-ups waiting for their time. One per friend: { kind: "reply" | "followup", dueAt, since, what, about }.
const pendingFile = (id) => contactPath(id, "pending.json");
const readPending = (id) => readJson(pendingFile(id), null);
function setPending(c, entry) {
  const cur = readPending(c.id);
  // A reply already on its way stays as it is; they'll answer everything at once.
  if (cur?.kind === "reply" && entry.kind === "reply") return cur;
  const next = cur ? { ...entry, kind: cur.kind === "reply" ? "reply" : entry.kind, dueAt: Math.min(cur.dueAt, entry.dueAt) } : entry;
  writeJson(pendingFile(c.id), next);
  return next;
}
// What the page picks up: new texts that arrived on their own, and friends calling back. Polled by /api/updates.
const updates = [];
let updateSeq = 0;
const pushUpdate = (u) => { updates.push({ seq: ++updateSeq, ...u }); if (updates.length > 200) updates.shift(); };
const delivering = new Set();
setInterval(async () => {
  if (Date.now() - lastPing > 90 * 1000 || !getClient() || config.airplane) return;
  for (const c of listContacts()) {
    // A pause from Support ("/Elena pause 3d") ends by itself.
    if (c.pausedUntil && Date.parse(c.pausedUntil) <= Date.now()) {
      const since = c.inactiveSince;
      c.active = true;
      delete c.pausedUntil;
      delete c.inactiveSince;
      saveContact(c);
      if (since) catchUp(loadContact(c.id), since).catch(() => {});
      addNotice(`${firstName(c)} is back on.`, c.id);
      continue;
    }
    const p = readPending(c.id);
    if (!p || p.dueAt > Date.now() || delivering.has(c.id) || c.active === false || call?.contactId === c.id) continue;
    delivering.add(c.id);
    fs.rmSync(pendingFile(c.id), { force: true });
    try {
      const out = await friendTexts(c, p.kind === "reply" ? { late: p } : { opener: true, about: p.about, late: p });
      pushUpdate({ type: "texts", contact: c.id, texts: out.texts });
      if (out.call) pushUpdate({ type: "call", contact: c.id });
    } catch (err) {
      console.error(`${c.name}'s reply failed:`, err?.message ?? err);
    } finally {
      delivering.delete(c.id);
    }
  }
}, 3000);

// Rules you set for everyone (Support: "/rule ..."), in data/rules.md, one per line.
const houseRulesFile = path.join(dataDir, "rules.md");
const readHouseRules = () => { try { return fs.readFileSync(houseRulesFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean); } catch { return []; } };
const writeHouseRules = (list) => fs.writeFileSync(houseRulesFile, list.join("\n") + (list.length ? "\n" : ""));
const houseRules = () => { const r = readHouseRules(); return r.length ? `# Your buddy's rules for everyone\nFollow these always:\n${r.map((x) => `- ${x.replace(/^[-*]\s*/, "")}`).join("\n")}` : ""; };

// ---- Support by text ----
// One support agent shows up in Messages as "Support". Plain texts are questions about the app (answered right away).
// Texts starting with / are commands (SUPPORT_HELP). Anything that rewrites a friend (their life story, schedule,
// memory) is shown first and applied on /yes. Every change is logged in data/changes.json and /undo reverses the last.
const supportAgent = () => listSupport().sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
function supportThread() {
  const sup = supportAgent();
  if (!sup) return [];
  const list = shownTexts(sup.id);
  const last = list.at(-1);
  return [{
    contact: sup.id, name: "Support", face: null, active: true, support: true,
    last: last ? last.text : "Text /help to see what I can change for you.", lastFrom: last?.from ?? "them",
    at: last?.at ?? new Date().toISOString(), unread: list.filter((t) => t.from === "them" && !t.read).length,
  }];
}
const SUPPORT_HELP = `Commands (anything else, just ask me):
For a friend, start with / and their first name, like /Joe or /Elena:
/{first name} got divorced: a change in their life (I'll show it first)
/{first name} show: their summary, schedule, rules, settings
/{first name} schedule works nights now
/{first name} rule never mention her ex
/{first name} forget the cornbread thing
/{first name} pause 3d, /{first name} resume
/{first name} calls daily, /{first name} texts often
/{first name} photo at the beach
For everyone:
/rule no one texts before 8am (everyone)
/rules, /rules delete 2
/me new job at Ford, 7 to 3
/quiet 10pm-7am, /work weekdays 9-5 (or /work off)
/who: who's free right now
/storage: what's using space; /tidy: clean up old data (I'll show it first)
/log, /undo
/yes, /no: answer a change I showed you

In a friend's own thread, start a text with /ai to tell them what to do, like: /ai send a pic of you at lunch`;

const changesFile = path.join(dataDir, "changes.json");
function logChange(entry) {
  writeJson(changesFile, [...readJson(changesFile, []), { at: new Date().toISOString(), ...entry }].slice(-100));
}
function undoLast() {
  const list = readJson(changesFile, []);
  const last = list.findLast((e) => !e.undone && e.undo);
  if (!last) return "Nothing to undo.";
  const u = last.undo;
  if (u.type === "persona") {
    fs.writeFileSync(path.join(personasDir, u.id, "persona.md"), u.before);
    const c = loadContact(u.id);
    if (c && typeof u.notesBefore === "string") { c.memory.notes = u.notesBefore; writeJson(contactPath(c.id, "memory.json"), c.memory); }
  } else if (u.type === "rules") writeHouseRules(u.before);
  else if (u.type === "profile") { config.user = u.before; writeJson(configFile, config); }
  else if (["schedule", "settings", "memory"].includes(u.type)) {
    const c = loadContact(u.id);
    if (!c) return "That friend is gone.";
    if (u.type === "schedule") { if (u.before) c.schedule = u.before; else delete c.schedule; saveContact(c); }
    if (u.type === "settings") { Object.assign(c, u.before); for (const k of Object.keys(u.before)) if (u.before[k] === undefined) delete c[k]; saveContact(c); }
    if (u.type === "memory") { c.memory[u.field] = u.before; writeJson(contactPath(c.id, "memory.json"), c.memory); }
  } else return "I can't undo that one.";
  last.undone = new Date().toISOString();
  writeJson(changesFile, list);
  return `Undone: ${last.what}`;
}

let supportProposal = null; // a change waiting for /yes: { what, apply }
const propose = (what, preview, apply) => { supportProposal = { what, apply }; return `${preview}\n\nReply /yes to make this change, or /no.`; };

// A friend's life update ("got divorced") rewrites the character part of their persona (the phone rules stay as they
// are), archives the old one, and adds a dated line to their notes so they know it's recent. Their identity is rebuilt
// at the next call or text.
async function proposeLifeUpdate(c, update) {
  const file = path.join(personasDir, c.id, "persona.md");
  const persona = fs.readFileSync(file, "utf8");
  const i = persona.indexOf(PHONE_RULES_HEADING);
  const character = (i >= 0 ? persona.slice(0, i) : persona).trimEnd();
  const msg = await getClient().messages.create({
    model: MEMORY_MODEL,
    max_tokens: 8000,
    output_config: { effort: "low" },
    system: `You update an AI friend's character description after a change in their life. Change only what the update affects (and what follows from it: names, living situation, daily life), keep everything else word for word, same Markdown layout. Then summarize what you changed in 1 to 3 short lines. If the update is something that happened in their life (a divorce, a move, a new job), also write it as one short line to them in the second person ("You and Marco divorced last month."), so they know it's recent; if it's only about how they talk or act, use null. Answer with JSON only: {"persona": "...", "summary": "...", "news": "..." or null}`,
    messages: [{ role: "user", content: `Character description of ${c.name}:\n${character}\n\nThe update: ${update}` }],
  });
  const out = JSON.parse(textOf(msg.content).replace(/^```(json)?|```$/gm, "").trim());
  if (!out?.persona?.startsWith("#")) throw new Error("I couldn't rewrite that. Try saying it another way.");
  const first = firstName(c);
  return propose(`${first}: ${update}`, `${first}, updated:\n${out.summary}`, () => {
    const fresh = loadContact(c.id);
    const notesBefore = fresh.memory.notes ?? "";
    fs.mkdirSync(contactPath(c.id, "persona-history"), { recursive: true });
    fs.writeFileSync(path.join(contactPath(c.id, "persona-history"), `${new Date().toISOString().replace(/[:.]/g, "-")}.md`), persona);
    fs.writeFileSync(file, `${out.persona.trim()}\n\n${i >= 0 ? persona.slice(i) : ""}`.trimEnd() + "\n");
    if (typeof out.news === "string" && out.news.trim()) {
      const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
      fresh.memory.notes = `${notesBefore}\n- Recent news in your own life (${today}): ${out.news.trim()}`.trim();
      writeJson(contactPath(c.id, "memory.json"), fresh.memory);
    }
    logChange({ what: `${first}: ${update}`, undo: { type: "persona", id: c.id, before: persona, notesBefore } });
    // A private friend's Desktop kit (with the persona that "Recreate" uses) gets the update too.
    const kit = desktopFolder(fresh) && path.join(path.dirname(desktopFolder(fresh)), "persona.md");
    if (kit && fs.existsSync(kit)) fs.writeFileSync(kit, fs.readFileSync(file, "utf8"));
    refreshIdentity(loadContact(c.id));
    ensureGreeting(loadContact(c.id));
    return `Done. ${first} will be living with it from the next call or text.`;
  });
}

function friendSummary(c) {
  const first = firstName(c);
  return [
    `${c.name}: your ${shownRole(c.role ?? "friend").replace("-", " ")}${c.active === false ? " (turned off)" : ""}${c.pausedUntil ? `, paused until ${new Date(c.pausedUntil).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}`,
    `Calls you: ${callsYouOf(c)}. Texts you: ${textsYouOf(c)}.`,
    `Right now ${first} is ${nowLine(c)}.`,
    `Schedule:\n${scheduleText(scheduleOf(c))}`,
    `Rules:\n${c.memory.rules || "(none)"}`,
  ].join("\n");
}

const parseDuration = (t) => {
  const m = String(t ?? "").match(/(\d+)\s*(m|min|h|hr|hour|d|day|w|week)?/i);
  if (!m) return null;
  const unit = (m[2] ?? "d").toLowerCase()[0];
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 864e5, w: 7 * 864e5 }[unit];
};

async function friendCommand(c, rest) {
  const first = firstName(c);
  const [w, ...more] = rest.split(/\s+/);
  const word = (w ?? "").toLowerCase();
  const arg = more.join(" ").trim();
  if (!word || word === "show") return friendSummary(c);
  if (word === "schedule") {
    if (!arg) return `${first}'s schedule:\n${scheduleText(scheduleOf(c))}`;
    const schedule = await reviseSchedule(c, arg);
    if (!schedule?.blocks.length) return "I couldn't work that schedule out. Try saying it another way.";
    return propose(`${first}'s schedule: ${arg}`, `${first}'s new schedule:\n${scheduleText(schedule)}`, () => {
      const fresh = loadContact(c.id);
      logChange({ what: `${first}'s schedule: ${arg}`, undo: { type: "schedule", id: c.id, before: fresh.schedule ?? null } });
      fresh.schedule = schedule;
      saveContact(fresh);
      return `Done. ${first}'s schedule is updated.`;
    });
  }
  if (word === "rule") {
    if (!arg) return `What rule? Like: /${first} rule never mention her ex`;
    const before = c.memory.rules ?? "";
    c.memory.rules = `${before}\n- ${arg.replace(/^[-*]\s*/, "")}`.trim();
    writeJson(contactPath(c.id, "memory.json"), c.memory);
    logChange({ what: `${first} rule: ${arg}`, undo: { type: "memory", id: c.id, field: "rules", before } });
    return `Done. ${first} will follow that from the next call or text.`;
  }
  if (word === "forget") {
    if (!arg) return `Forget what? Like: /${first} forget the cornbread thing`;
    const before = c.memory.notes ?? "";
    const out = await askJson([{ type: "text", text: `Notes:\n${before}\n\nRemove everything about: ${arg}. Keep all other lines exactly. Reply with only JSON: {"notes": "the notes without those lines", "removed": "the removed lines"}` }]);
    if (!out?.removed?.trim()) return `I didn't find anything about that in ${first}'s notes.`;
    return propose(`${first} forgets: ${arg}`, `${first} will forget:\n${out.removed}`, () => {
      const fresh = loadContact(c.id);
      logChange({ what: `${first} forgets: ${arg}`, undo: { type: "memory", id: c.id, field: "notes", before: fresh.memory.notes ?? "" } });
      fresh.memory.notes = out.notes;
      writeJson(contactPath(c.id, "memory.json"), fresh.memory);
      return `Done. ${first} won't remember that.`;
    });
  }
  if (word === "pause") {
    const ms = parseDuration(arg || "1d");
    if (!ms) return `For how long? Like: /${first} pause 3d`;
    logChange({ what: `${first} paused for ${arg || "1d"}`, undo: { type: "settings", id: c.id, before: { active: c.active, pausedUntil: c.pausedUntil, inactiveSince: c.inactiveSince } } });
    c.active = false;
    c.inactiveSince ??= new Date().toISOString();
    c.pausedUntil = new Date(Date.now() + ms).toISOString();
    saveContact(c);
    return `${first} is paused until ${new Date(c.pausedUntil).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })}. They'll catch up when they're back.`;
  }
  if (word === "resume") {
    if (c.active !== false) return `${first} is already on.`;
    const since = c.inactiveSince;
    logChange({ what: `${first} back on`, undo: { type: "settings", id: c.id, before: { active: false, pausedUntil: c.pausedUntil, inactiveSince: c.inactiveSince } } });
    c.active = true;
    delete c.pausedUntil;
    delete c.inactiveSince;
    saveContact(c);
    if (since) catchUp(loadContact(c.id), since).catch(() => {});
    return `${first} is back on and catching up.`;
  }
  if (word === "calls" || word === "texts") {
    const choices = word === "calls" ? CALLS_YOU : TEXTS_YOU;
    if (!choices.includes(arg)) return `Pick one: ${choices.join(", ")}`;
    const key = word === "calls" ? "callsYou" : "textsYou";
    logChange({ what: `${first} ${word} ${arg}`, undo: { type: "settings", id: c.id, before: { settings: { ...c.settings } } } });
    c.settings[key] = arg;
    saveContact(c);
    return `Done. ${first} ${word} you: ${arg}.`;
  }
  if (word === "photo") {
    if (!arg) return `A photo of what? Like: /${first} photo at the beach`;
    setPending(c, { kind: "followup", dueAt: Date.now() + (20 + Math.random() * 60) * 1000, since: new Date().toISOString(), what: "free", about: `you're sending your buddy a photo: ${arg}` });
    return `Okay, ${first} will send it soon.`;
  }
  return proposeLifeUpdate(c, rest);
}

async function supportCommand(text) {
  const [w, ...more] = text.slice(1).trim().split(/\s+/);
  const word = (w ?? "").toLowerCase();
  const rest = more.join(" ").trim();
  if (word === "help" || !word) {
    const names = listContacts().filter((f) => f.active !== false).map((f) => `/${firstName(f)}`);
    return `${SUPPORT_HELP}${names.length ? `

Your friends: ${names.join(", ")}` : ""}`;
  }
  if (word === "yes") {
    if (!supportProposal) return "There's nothing waiting for a yes.";
    const p = supportProposal;
    const done = await p.apply(); // if it fails, the change stays waiting so /yes can try again
    supportProposal = null;
    return done;
  }
  if (word === "no") { supportProposal = null; return "Okay, I left it as it was."; }
  if (word === "undo") return undoLast();
  if (word === "log") {
    const list = readJson(changesFile, []).slice(-10);
    return list.length ? list.map((e) => `${new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: ${e.what}${e.undone ? " (undone)" : ""}`).join("\n") : "No changes yet.";
  }
  if (word === "rule") {
    if (!rest) return "What rule? Like: /rule no one texts before 8am";
    const before = readHouseRules();
    writeHouseRules([...before, rest]);
    logChange({ what: `Rule for everyone: ${rest}`, undo: { type: "rules", before } });
    return "Done. Everyone follows it from their next call or text.";
  }
  if (word === "rules") {
    const list = readHouseRules();
    const del = rest.match(/^(delete|remove)\s+(\d+)/i);
    if (del) {
      const n = Number(del[2]);
      if (!list[n - 1]) return "There's no rule with that number. Text /rules to see them.";
      logChange({ what: `Removed rule: ${list[n - 1]}`, undo: { type: "rules", before: list } });
      writeHouseRules(list.filter((_, i) => i !== n - 1));
      return `Removed: ${list[n - 1]}`;
    }
    return list.length ? list.map((r, i) => `${i + 1}. ${r}`).join("\n") : "No rules for everyone yet. Add one with /rule.";
  }
  if (word === "me") {
    if (!rest) return "What changed? Like: /me new job at Ford, 7 to 3";
    const before = JSON.parse(JSON.stringify(config.user ?? {}));
    await afterSupportCall(`Caller: ${rest}\nAgent: Got it, I'll update your profile.`);
    logChange({ what: `About you: ${rest}`, undo: { type: "profile", before } });
    return "Done. Your friends will hear about it naturally.";
  }
  if (word === "quiet" || word === "work") {
    const off = /^off$/i.test(rest);
    const out = off ? null : await askJson([{ type: "text", text: `Turn this into hours: "${rest}". Reply with only JSON: {"days": "daily" | "weekdays" | "weekends" | "mon,tue,...", "from": "HH:MM" (24-hour), "to": "HH:MM"}` }]);
    if (!off && !/^\d{2}:\d{2}$/.test(out?.from ?? "")) return `I couldn't read that. Like: /${word} ${word === "quiet" ? "10pm-7am" : "weekdays 9-5"}`;
    const before = JSON.parse(JSON.stringify(config.user ?? {}));
    config.user = config.user ?? {};
    config.user.hours = config.user.hours ?? {};
    if (off) delete config.user.hours[word];
    else config.user.hours[word] = word === "quiet" ? { from: out.from, to: out.to } : { days: out.days ?? "weekdays", from: out.from, to: out.to };
    writeJson(configFile, config);
    logChange({ what: `Your ${word} hours: ${rest}`, undo: { type: "profile", before } });
    return off ? `Your ${word} hours are off.` : word === "quiet"
      ? `Quiet hours: ${out.from} to ${out.to}. No calls or texts from friends then.`
      : `Work hours: ${out.days} ${out.from} to ${out.to}. Friends won't call then; texts are fine.`;
  }
  if (word === "storage") return storageReport();
  if (word === "tidy") {
    const actions = planTidy();
    if (!actions.length) return "Nothing to tidy right now. Everything is still in use.";
    const total = actions.reduce((n, a) => n + a.bytes, 0);
    return propose("Tidy up", `I'd tidy up about ${mb(total)}:\n${actions.map((a) => `- ${a.what}`).join("\n")}\nMemories, rules, personas and anything unheard or unsent stay.`, () => {
      const { freed } = runTidy(actions);
      return `Done. About ${mb(freed)} freed.`;
    });
  }
  if (word === "who") return listContacts().filter((c) => c.active !== false).map((c) => `${firstName(c)}: ${nowLine(c)}`).join("\n") || "No friends installed.";
  const c = listContacts().find((f) => firstName(f).toLowerCase() === word || f.id === word);
  if (c) return friendCommand(c, rest);
  return `I don't know /${w}. Text /help to see the commands.`;
}

// A text to Support: a command, or a question answered by the agent right away.
async function supportText(sup, said) {
  let reply;
  if (said.startsWith("/")) {
    try { reply = await supportCommand(said); } catch (err) { reply = `That didn't work: ${err?.message ?? err}`; }
    const entry = { id: `${Date.now()}`, from: "them", text: reply, at: new Date().toISOString(), read: false };
    writeTexts(sup.id, [...readTexts(sup.id), entry]);
    return { texts: [entry], call: false, reaction: null };
  }
  return friendTexts(sup, {});
}

// ---- /ai: telling a friend what to do ----
// A text to a friend that starts with /ai is a direction from you, not part of the conversation: "/ai send a pic of you
// at lunch". They do it right away, in character and within all their rules (and Claude's), without arguing, asking
// why, or turning it into a call. The /ai text itself isn't shown or remembered; what they send is.
async function aiDirect(c, ask) {
  const added = [];
  let photo = null;
  let video = null;
  if (/\b(videos?|clips?|tiktoks?|reels?|vids?)\b/i.test(ask)) {
    video = await friendVideo(c, ask);
    added.push({ id: `${Date.now()}-v`, from: "them", text: "", video, at: new Date().toISOString(), read: false });
    writeTexts(c.id, [...readTexts(c.id), ...added]);
  } else if (/\b(pics?|pictures?|photos?|selfies?|images?|snap(shot)?)\b/i.test(ask)) {
    photo = await friendPhoto(c, ask).catch((err) => (console.error("Photo failed:", err?.message ?? err), null));
    if (!photo) throw new Error("That picture couldn't be made right now. Try again in a bit, or describe it another way.");
    added.push({ id: `${Date.now()}-p`, from: "them", text: "", photo, at: new Date().toISOString(), read: false });
    writeTexts(c.id, [...readTexts(c.id), ...added]);
  }
  const sent = video ?? photo;
  const direct = sent
    ? `(Your buddy asked you for a ${video ? "video" : "photo"}, and you just sent it. It shows: ${sent.desc}. Text one short line to go with it, in your own style. Don't ask about it, don't argue, don't say you'll call, and don't send another photo.)`
    : `(A direction from your buddy, who set you up, given outside the conversation: "${ask}". Your next texts must be exactly that, in your own voice and within your rules, and nothing else: not a reaction to earlier texts, not a complaint that they haven't answered, not a question about it, and not an offer to call instead.)`;
  const out = await friendTexts(c, { direct, noPhoto: true }); // only the photo you asked for
  return { texts: [...added, ...out.texts], call: false, reaction: null };
}

// ---- Tidying up (weekly, by itself; or "/tidy" in Support) ----
// Data that's no longer needed day to day is trimmed. Never touched: memory notes, rules, personas, voices, faces,
// your profile and keys, and anything unheard or unsent.
// - Voicemail audio you've heard, over 30 days old: the audio goes; the words stay (audioGone).
// - Made pictures that were rejected, or never sent and over 60 days old (and not approved): removed from the album.
//   Their copy in Desktop\Call Joe\<friend>\generated stays.
// - Your album pictures over 1 MB: shrunk to phone size, after the original is copied to Desktop\Call Joe\<friend>\
//   album originals (skipped where there's no Desktop folder, like test copies).
// - Texts over 90 days old that are already in the memory notes: moved to texts-archive-<year>.json.gz.
// - Persona history and profile history: the newest 20 of each are kept.
const DAY = 864e5;
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
function keepNewest(dirPath, n) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).map((f) => path.join(dirPath, f)).filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(n);
}

// What a tidy-up would do: a list of { what, bytes, run }.
function planTidy() {
  const actions = [];
  const now = Date.now();
  for (const c of listContacts()) {
    const first = firstName(c);
    // Old voicemail audio.
    const vms = readVoicemails(c.id);
    const oldAudio = vms.filter((v) => v.heard && !v.audioGone && now - Date.parse(v.at) > 30 * DAY && fs.existsSync(path.join(voicemailDir(c.id), `${v.id}.wav`)));
    if (oldAudio.length) {
      actions.push({
        what: `${first}: audio of ${oldAudio.length} old voicemail${oldAudio.length > 1 ? "s" : ""} (words kept)`,
        bytes: oldAudio.reduce((n, v) => n + fileSize(path.join(voicemailDir(c.id), `${v.id}.wav`)), 0),
        run: () => {
          const list = readVoicemails(c.id);
          for (const v of list) if (oldAudio.some((o) => o.id === v.id)) { fs.rmSync(path.join(voicemailDir(c.id), `${v.id}.wav`), { force: true }); v.audioGone = true; }
          writeVoicemails(c.id, list);
        },
      });
    }
    // Rejected and unused made pictures.
    const rejectedDir = path.join(photoDir(c.id), MADE, "rejected");
    const rejected = fs.existsSync(rejectedDir) ? fs.readdirSync(rejectedDir).map((f) => path.join(rejectedDir, f)) : [];
    const approved = new Set(readMadeLog(c.id).filter((e) => e.approved).map((e) => e.file));
    const unused = readAlbum(c.id).filter((p) => p.made && !p.sentAt && !approved.has(p.file) && now - Date.parse(p.at) > 60 * DAY);
    if (rejected.length || unused.length) {
      actions.push({
        what: `${first}: ${rejected.length + unused.length} made picture${rejected.length + unused.length > 1 ? "s" : ""} (${rejected.length} rejected, ${unused.length} never sent)`,
        bytes: rejected.reduce((n, f) => n + fileSize(f), 0) + unused.reduce((n, p) => n + fileSize(path.join(photoDir(c.id), p.file)), 0),
        run: () => {
          copyMadeToDesktop(c); // make sure the Desktop has them first
          for (const f of rejected) fs.rmSync(f, { force: true });
          for (const p of unused) fs.rmSync(path.join(photoDir(c.id), p.file), { force: true });
          writeAlbum(c.id, readAlbum(c.id).filter((p) => !unused.some((u) => u.file === p.file)));
        },
      });
    }
    // Big album pictures you added.
    const desk = desktopFolder(c);
    const big = desk ? readAlbum(c.id).filter((p) => !p.made && fileSize(path.join(photoDir(c.id), p.file)) > 1048576) : [];
    if (big.length) {
      actions.push({
        what: `${first}: shrink ${big.length} big album picture${big.length > 1 ? "s" : ""} to phone size (originals to the Desktop)`,
        bytes: big.reduce((n, p) => n + fileSize(path.join(photoDir(c.id), p.file)) * 0.85, 0),
        run: () => {
          const originals = path.join(path.dirname(desk), "album originals");
          fs.mkdirSync(originals, { recursive: true });
          for (const p of big) {
            const f = path.join(photoDir(c.id), p.file);
            const keep = path.join(originals, path.basename(p.file));
            if (!fs.existsSync(keep)) fs.copyFileSync(f, keep);
            execFileSync(path.join(dir, "voice", ".venv", "Scripts", "python.exe"), [path.join(dir, "tools", "shrink-picture.py"), f], { windowsHide: true });
          }
        },
      });
    }
    // Old texts already in the memory notes.
    const texts = readTexts(c.id);
    const oldTexts = texts.filter((t) => t.remembered && now - Date.parse(t.at) > 90 * DAY);
    if (oldTexts.length) {
      actions.push({
        what: `${first}: archive ${oldTexts.length} texts older than 90 days (already in memory)`,
        bytes: Buffer.byteLength(JSON.stringify(oldTexts)) * 0.8,
        run: () => {
          const byYear = {};
          for (const t of oldTexts) (byYear[new Date(t.at).getFullYear()] ??= []).push(t);
          for (const [year, list] of Object.entries(byYear)) {
            const file = contactPath(c.id, `texts-archive-${year}.json.gz`);
            const before = fs.existsSync(file) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")) : [];
            fs.writeFileSync(file, zlib.gzipSync(JSON.stringify([...before, ...list])));
          }
          const ids = new Set(oldTexts.map((t) => t.id));
          writeTexts(c.id, readTexts(c.id).filter((t) => !ids.has(t.id)));
        },
      });
    }
    // Old persona versions.
    const extraPersonas = keepNewest(contactPath(c.id, "persona-history"), 20);
    if (extraPersonas.length) actions.push({ what: `${first}: ${extraPersonas.length} old persona versions`, bytes: extraPersonas.reduce((n, f) => n + fileSize(f), 0), run: () => extraPersonas.forEach((f) => fs.rmSync(f, { force: true })) });
  }
  const extraProfiles = keepNewest(path.join(dataDir, "profile-history"), 20);
  if (extraProfiles.length) actions.push({ what: `${extraProfiles.length} old profile versions`, bytes: extraProfiles.reduce((n, f) => n + fileSize(f), 0), run: () => extraProfiles.forEach((f) => fs.rmSync(f, { force: true })) });
  return actions;
}
function runTidy(actions) {
  let freed = 0;
  const done = [];
  for (const a of actions) {
    try { a.run(); freed += a.bytes; done.push(a.what); } catch (err) { console.error(`Tidy-up step failed (${a.what}):`, err?.message ?? err); }
  }
  config.lastTidy = new Date().toISOString();
  writeJson(configFile, config);
  if (done.length) logChange({ what: `Tidied up: ${done.join("; ")} (about ${mb(freed)})` });
  return { freed, done };
}
// Once a week, while the app is open.
setInterval(() => {
  if (Date.now() - lastPing > 90 * 1000 || call) return;
  if (config.lastTidy && Date.now() - Date.parse(config.lastTidy) < 7 * DAY) return;
  const { freed, done } = runTidy(planTidy());
  if (done.length) addNotice(`Tidied up old data: about ${mb(freed)} freed. Memories and anything unheard or unsent are untouched. Text Support /log for details.`);
}, 60 * 60 * 1000);

// What's using space, for "/storage".
function dirSize(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, f) => n + dirSize(path.join(p, f)), 0);
}
function storageReport() {
  const rows = listAll().map((c) => {
    const d = path.join(contactsDir, c.id);
    return { name: c.support ? `${firstName(c)} (support)` : firstName(c), total: dirSize(d), pics: dirSize(photoDir(c.id)), vm: dirSize(voicemailDir(c.id)) };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  const lines = rows.map((r) => `${r.name}: ${mb(r.total)}${r.pics ? ` (pictures ${mb(r.pics)}` : " ("}${r.vm ? `${r.pics ? ", " : ""}voicemail ${mb(r.vm)}` : ""})`.replace(" ()", ""));
  const voices = dirSize(path.join(dataDir, "voices")), faces = dirSize(facesDir);
  return [`Everything: ${mb(dirSize(dataDir))}`, ...lines, `Voice clips: ${mb(voices)}`, `Face pictures: ${mb(faces)}`,
    `Last tidy-up: ${config.lastTidy ? new Date(config.lastTidy).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "not yet"}`].join("\n");
}

// ---- Text messages ----
// data/contacts/<id>/texts.json: [{ id, from: "me" | "them", text, at, read, remembered }]. Friends text back short,
// the way people really text. A long back-and-forth turns into a phone call (they text that they're calling and ring
// you), at a point set by who they are to you and their personality, which also keeps API use down. Texts reach the
// memory notes with the next call, or on their own once 20 pile up.
const textsFile = (id) => contactPath(id, "texts.json");
const readTexts = (id) => readJson(textsFile(id), []);
const writeTexts = (id, list) => writeJson(textsFile(id), list.slice(-500));
// Deleting a conversation in Messages only hides it ("hidden"): the friend still remembers it and keeps the context.
const shownTexts = (id) => readTexts(id).filter((t) => !t.hidden);
const CALL_MARK = "<call>";
// How many of your texts in one conversation before they'd rather call. Moms, grandparents and neighbors call sooner;
// best friends and siblings will text for ages. friend.json "texting": "calls" (prefers calling) cuts it, "texts" stretches it.
const TEXTS_BEFORE_CALL = {
  mom: 4, dad: 5, grandparent: 3, spouse: 8, sister: 8, brother: 8, "best-friend": 10, "girlfriend-bestie": 12,
  "close-friend": 8, cousin: 8, aunt: 5, uncle: 5, friend: 6, "family-friend": 5, neighbor: 4, coworker: 4,
  "romantic-interest": 12,
};
const TEXTING_SCALE = { calls: 0.6, normal: 1, texts: 1.5 };
function textsBeforeCall(c) {
  const style = c.texting ?? catalogEntry(c.id)?.texting ?? "normal";
  return Math.max(2, Math.round((TEXTS_BEFORE_CALL[c.role] ?? 6) * (TEXTING_SCALE[style] ?? 1)));
}
// The current conversation: texts with no gap longer than 30 minutes.
function currentThread(list) {
  let i = list.length - 1;
  while (i > 0 && Date.parse(list[i].at) - Date.parse(list[i - 1].at) < 30 * 60 * 1000) i--;
  return list.slice(Math.max(i, 0));
}
const textWhen = (iso) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });

const TEXTING = `# Right now you're texting, not on the phone
Your buddy and you are texting. Text back like a real person on their phone: short and casual, the way you'd really text. Younger or easygoing people use lowercase, abbreviations and an emoji now and then; older people text in fuller sentences, maybe with an odd emoji. Each text is a sentence or two at most, usually under 20 words. Usually one text, sometimes two or three quick ones in a row. Put a line with only --- between separate texts. Never write paragraphs, never put times or dates in brackets, and never use the hang-up marker.
If something is serious, upsetting, or easier said out loud, you can say you'll call instead, and end with ${CALL_MARK}.
You can react to your buddy's last text like a tapback by starting your reply with [react: one emoji], like [react: 😂], when that's what you'd do; you can still text after it, or not. Now and then, when it really fits, you can send a GIF instead of words: a line with only [gif: a few search words]. When your buddy sends a GIF, react to what it shows.`;

// ---- GIFs (GIPHY): needs a free GIPHY API key, saved in Settings -> Account ----
async function searchGifs(q, limit = 18) {
  if (!config.giphyKey) throw new Error("Add a GIPHY key in Settings → Account to send GIFs.");
  const kind = q ? "search" : "trending";
  const u = new URL(`https://api.giphy.com/v1/gifs/${kind}`);
  u.search = new URLSearchParams({ api_key: config.giphyKey, limit: String(limit), rating: "pg-13", ...(q ? { q } : {}) });
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "GIPHY didn't accept the key." : `GIPHY answered ${r.status}.`);
  const j = await r.json();
  return (j.data ?? []).map((g) => ({
    id: g.id, title: (g.title || q || "GIF").replace(/\s*GIF.*$/i, "").trim() || "GIF",
    url: g.images?.fixed_height?.url, small: g.images?.fixed_height_small?.url ?? g.images?.fixed_height?.url,
  })).filter((g) => g.url);
}

// What a GIF shows, in words. Friends can't see pictures in texts, and GIPHY titles are often empty or odd ("GIF",
// "Music Video Wtf"), so when you send one, Claude looks at it once and describes it; friends get that description
// in texts, calls and memory. GIPHY's still frame (200_s.gif) is small; the animated one is the fallback.
async function describeGif(gif) {
  if (!getClient()) return null;
  const still = gif.url.replace(/\/(\d+)(w?)\.gif(\?.*)?$/, "/$1$2_s.gif");
  for (const url of [still, gif.url]) {
    try {
      const msg = await getClient().messages.create({
        model: NEWS_MODEL,
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "url", url } },
            { type: "text", text: `This is a frame from a reaction GIF someone texted a friend (GIPHY's title: "${gif.title}"). In one short sentence, say what it shows and what the sender probably means by it, like "Steve Carell screaming 'no!', meaning: oh no, you've got to be kidding." Output only that sentence.` },
          ],
        }],
      });
      const text = textOf(msg.content).trim();
      if (text && msg.stop_reason !== "refusal") return text.slice(0, 300);
    } catch (err) {
      console.error("Describing a GIF failed:", err?.message ?? err);
    }
  }
  return null;
}
const gifWords = (gif) => gif.desc ?? gif.title;

// ---- Photos friends text you ----
// Each friend has an album: data/contacts/<id>/photos/ (private, never committed). Drop pictures in it, named by what
// they show if you like ("Mateo soccer.jpg"); Claude looks at each one once and writes it into index.json. Pictures
// made for them go in photos/made/, with made/prompts.json logging each request, prompt, guides and result; ones
// you delete are marked rejected, and the planner reads that log to write better prompts next time. When a
// friend texts [photo: what it shows], the best album match is sent. If none fits, a new picture is made on the
// graphics card (pictures/picture_server.py), guided by album pictures and the friend's face, checked by Claude, and
// added to the album, so the same kids and things keep looking the same.
const PHOTO_EXT = /\.(jpe?g|png|webp)$/i;
const photoDir = (id) => path.join(contactsDir, id, "photos");
const readAlbum = (id) => readJson(path.join(photoDir(id), "index.json"), []);
const writeAlbum = (id, list) => writeJson(path.join(photoDir(id), "index.json"), list);
const MADE = "made"; // subfolder for pictures made for the friend (auto-generated), "made/<name>" in the album
const madeLogFile = (id) => path.join(photoDir(id), MADE, "prompts.json");
const readMadeLog = (id) => readJson(madeLogFile(id), []);
// Made pictures and their prompt log are also copied to your Desktop, Desktop\Call Joe\<friend's folder>\generated\,
// so you can look through them (the friend's existing folder there is used, like "Elena Rodriguez"; otherwise one is
// made). Test copies (CALLJOE_DATA) don't copy anything there.
const DESKTOP_DIR = path.join(os.homedir(), "Desktop", "Call Joe");
function desktopFolder(c) {
  if (process.env.CALLJOE_DATA) return null;
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  const words = c.name.toLowerCase().split(/\s+/);
  const found = fs.readdirSync(DESKTOP_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
    .find((d) => d.name.toLowerCase() === c.name.toLowerCase())
    ?? fs.readdirSync(DESKTOP_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
      .find((d) => d.name.toLowerCase().split(/[\s()]+/)[0] === words[0] || d.name.toLowerCase().split(/[\s()]+/).includes(words.at(-1)));
  return path.join(DESKTOP_DIR, found?.name ?? c.name.replace(/[<>:"/\\|?*]/g, ""), "generated");
}
function copyMadeToDesktop(c) {
  try {
    const out = desktopFolder(c);
    if (!out) return;
    fs.mkdirSync(out, { recursive: true });
    const made = path.join(photoDir(c.id), MADE);
    for (const f of fs.existsSync(made) ? fs.readdirSync(made) : []) {
      const target = path.join(out, f);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(made, f), target);
    }
    if (fs.existsSync(madeLogFile(c.id))) fs.copyFileSync(madeLogFile(c.id), path.join(out, "prompts.json"));
  } catch (err) {
    console.error("Copying pictures to the Desktop failed:", err?.message ?? err);
  }
}

// What earlier pictures taught: the request, the prompt, and how it came out (kept, failed the check, or deleted by you).
function madeLessons(id) {
  const log = readMadeLog(id).slice(-10);
  if (!log.length) return "";
  return `Pictures made for them before (learn from these: repeat what worked, avoid what was rejected):\n` + log.map((e) =>
    `- asked for "${e.want}" -> prompt: "${e.prompt}" -> ${e.removed ? `REJECTED by your buddy${e.feedback ? `: ${e.feedback}` : ""}` : e.approved ? `APPROVED by your buddy (do more like this): ${e.approved}` : e.kept ? `kept, came out as: ${e.desc}` : `discarded (${e.why ?? "failed"})`}`).join("\n") + "\n";
}
const photoMime = (f) => (/\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg");
const PHOTO_RULES = "Allowed: everyday phone photos. Never nudity or sexual content. Flirty is fine for adults (heels, a pedicure, a dress, legs crossed at dinner), always fully clothed. Children only ever appear in ordinary, wholesome family moments (games, school, birthdays, holidays), fully clothed, never posed or styled like adults.";
const PHOTO_NEGATIVE = "nude, naked, nsfw, topless, nipples, lingerie, underwear, bikini, sexual, explicit, cartoon, illustration, painting, anime, 3d render, text, words, letters, caption, banner, sign, watermark, logo, deformed, extra fingers, extra limbs, bad anatomy, blurry";
const pictureModelReady = () => fs.existsSync(path.join(os.homedir(), ".cache", "huggingface", "hub", "models--SG161222--RealVisXL_V5.0"));
const photoHabits = (c) => c.photoHabits ?? catalogEntry(c.id)?.photoHabits;
// friend.json "looks": what the friend looks like (always with skin tone), so pictures of them, even just legs, match.
const looksOf = (c) => c.looks ?? catalogEntry(c.id)?.looks;
const photoRules = (c) => `\nNow and then, when it really fits, you can text a photo you took: a line with only [photo: what the picture shows, in a few plain words]${photoHabits(c) ? `. You'd snap things like ${photoHabits(c)}` : ""}. Your buddy sees the picture. Not every time, just every so often, like a real person. Only when your buddy asks you for a video, send a short one: a line with only [video: what it shows and what happens]. Never send a video on your own. Your photos are part of your character, like your stories: your buddy set them up and knows they're made-up pictures, so sending them (even of yourself) is fine and nothing to apologize for. If they sincerely ask whether you're real, still answer honestly.${spicyOn(c) ? " Since your buddy turned on spicy pictures, a photo or video of just you can be sexy and R-rated (lingerie, topless, nude, boudoir) when the moment's right or they ask; nobody else is ever in those, and anything with your kids or family stays wholesome." : ""}`;

// Claude, briefly, answering in JSON (null if it can't).
// It sometimes thinks first and answers with no text, so it gets room for that and a second try.
async function askJson(content, model = NEWS_MODEL) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = await getClient().messages.create({ model, max_tokens: 4000, messages: [{ role: "user", content }] });
      if (msg.stop_reason === "refusal") return null;
      const answer = textOf(msg.content);
      if (answer.includes("{")) return JSON.parse(answer.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
    } catch (err) {
      console.error("Photo helper failed:", err?.message ?? err);
    }
  }
  return null;
}

// Looks at a picture once: what it shows, and whether it's fine to send.
async function describePhoto(c, file) {
  const full = path.join(photoDir(c.id), file);
  if (fs.statSync(full).size > 4.5 * 1024 * 1024) return { desc: "", ok: false, note: "too big to look at (over 4.5 MB)" };
  // Made pictures and video frames (in subfolders) have no meaningful name.
  const hint = file.includes("/") ? "" : ` Its file name is "${file.replace(PHOTO_EXT, "")}", which may name who or what is in it.`;
  const about = catalogEntry(c.id)?.about ?? c.name;
  const out = await askJson([
    { type: "image", source: { type: "base64", media_type: photoMime(file), data: fs.readFileSync(full).toString("base64") } },
    { type: "text", text: `This picture is in the camera roll of ${about}.${hint}\n${PHOTO_RULES}\nReply with only JSON: {"desc": "one plain sentence saying what it shows, with each person's skin tone and hair, using names from the file name if it gives them", "ok": false if it breaks the rules above, otherwise true}` },
  ]);
  return out && typeof out.desc === "string" ? { desc: out.desc.slice(0, 300), ok: out.ok !== false } : null;
}

// Brings the album's index up to date with the pictures in the folder.
async function syncAlbum(c) {
  fs.mkdirSync(path.join(photoDir(c.id), MADE), { recursive: true });
  const files = [
    ...fs.readdirSync(photoDir(c.id)).filter((f) => PHOTO_EXT.test(f)),
    ...fs.readdirSync(path.join(photoDir(c.id), MADE)).filter((f) => PHOTO_EXT.test(f)).map((f) => `${MADE}/${f}`),
  ];
  let album = readAlbum(c.id).filter((p) => files.includes(p.file));
  // A made picture you deleted from the folder is remembered as rejected.
  const log = readMadeLog(c.id);
  let changed = false;
  for (const e of log) if (e.kept && !e.removed && !files.includes(e.file)) { e.removed = new Date().toISOString(); changed = true; }
  if (changed) writeJson(madeLogFile(c.id), log);
  for (const file of files.filter((f) => !album.some((p) => p.file === f))) {
    if (!getClient()) break;
    const seen = await describePhoto(c, file);
    if (seen) album.push({ file, ...seen, at: new Date().toISOString() });
  }
  writeAlbum(c.id, album);
  return album;
}

// ---- Gemini pictures (Google's Nano Banana): needs a Google AI key, saved in Settings -> Account ----
// With a key, new pictures are made by Google from the friend's album pictures and face, which keeps people looking
// the same far better than the local model. The prompt and reference pictures go to Google; the result is still
// checked by Claude before it's sent. Without a key (or in airplane mode) the local picture server is used.
const GEMINI_IMAGE_MODEL = "gemini-nano-banana-2.1";
// When Google refuses (no billing on the key, over the limit), it rests for a while and the local model fills in.
let geminiProblem = null; // { until, message }
const geminiReady = () => !!config.googleKey && !config.airplane && !(geminiProblem && Date.now() < geminiProblem.until);
async function geminiCheckKey(key) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(r.status === 400 || r.status === 401 || r.status === 403 ? "Google didn't accept the key." : `Google answered ${r.status}.`);
}
// The first base64 image anywhere in Google's answer (the Interactions API's shape is still settling).
function findImage(v) {
  if (!v || typeof v !== "object") return null;
  const d = v.inlineData ?? v.inline_data;
  if (d?.data) return { data: d.data, mime: d.mimeType ?? d.mime_type ?? "image/png" };
  if (v.data && typeof v.data === "string" && v.data.length > 1000 && (v.type === "image" || v.mime_type || v.mimeType)) return { data: v.data, mime: v.mime_type ?? v.mimeType ?? "image/png" };
  for (const x of Array.isArray(v) ? v : Object.values(v)) {
    const found = findImage(x);
    if (found) return found;
  }
  return null;
}
async function geminiPicture(prompt, refs) {
  let budget = 12 * 1024 * 1024; // keep the request under Google's size limit
  const images = [];
  for (const f of refs) {
    const size = fs.statSync(f).size;
    if (size > budget) continue;
    budget -= size;
    images.push({ type: "image", mime_type: photoMime(f), data: fs.readFileSync(f).toString("base64") });
  }
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.googleKey },
    signal: AbortSignal.timeout(3 * 60 * 1000),
    body: JSON.stringify({
      model: GEMINI_IMAGE_MODEL,
      input: [{ type: "text", text: prompt }, ...images],
      response_format: { type: "image", aspect_ratio: "3:4", image_size: "1K" },
    }),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok) {
    const why = String(out?.error?.message ?? out?.message ?? JSON.stringify(out)).slice(0, 300);
    if ([400, 401, 403, 429].includes(r.status)) {
      geminiProblem = {
        until: Date.now() + 30 * 60 * 1000,
        message: /free tier|limit: 0|billing/i.test(why) ? "Google won't make pictures on a free key: turn on billing for it in Google AI Studio." : `Google refused (${r.status}): ${why.slice(0, 120)}`,
      };
    }
    throw new Error(`Google answered ${r.status}: ${why}`);
  }
  const img = findImage(out);
  if (!img) throw new Error(`Google sent no picture: ${JSON.stringify(out).slice(0, 300)}`);
  return img;
}

// A new picture for the album, made from a description. Returns the album entry, or null.
async function makePhoto(c, want, album) {
  const gemini = geminiReady();
  // The local model doesn't run during a call: the voice and face need the graphics card then. The album still works.
  if (!gemini && (!pictureModelReady() || call)) return null;
  const usable = album.filter((p) => p.ok);
  const face = faceFile(c.settings.face);
  let persona = "";
  try { persona = fs.readFileSync(path.join(personasDir, c.id, "persona.md"), "utf8").slice(0, 2500); } catch {}
  const plan = await askJson([{ type: "text", text: `${persona || c.name}

${c.name} wants to text a photo they just took: "${want}".
${looksOf(c) ? `What ${c.name.split(" ")[0]} looks like: ${looksOf(c)}.
` : ""}Whenever ${c.name.split(" ")[0]} or any part of them (face, legs, feet, hands) is in the picture, the prompt must say so with their looks in full detail (skin tone, and the shape and finish of whatever body part shows, exactly as described above), and you pick camera-roll pictures of them as guides.
Pictures already in their camera roll:
${usable.map((p, i) => `${i + 1}. ${p.desc}`).join("\n") || "(none)"}
${madeLessons(c.id)}${PHOTO_RULES}
Write a prompt for a photo-style image model${gemini ? " that is also given the camera-roll pictures you pick (and their face picture, if their face shows) as references: a few plain sentences saying to keep each person looking exactly like in the references (face, skin tone, hair, body) in a brand-new scene, then describe it: a candid, unposed smartphone photo," : ", under 60 words with the main subject first: a candid smartphone photo,"} natural light, realistic, describing exactly what was asked for and everyone in it concretely (age, skin tone, hair, clothes), so they look like the same people as in the camera roll and the description above. If anyone in the photo also appears in a camera-roll picture (like the family, or the same shoes), pick that picture (up to ${gemini ? 3 : 2}) to guide their look; otherwise pick none. Say whether ${c.name.split(" ")[0]}'s face is in the picture (their face picture is used then). If the photo can't be made within the rules, give an empty prompt.
Reply with only JSON: {"prompt": "...", "refs": [numbers], "self": true if their face shows, otherwise false, "people": true if anyone is in the picture, otherwise false}` }]);
  if (!plan?.prompt) return null;
  console.log(`Making a photo for ${c.name}: ${plan.prompt} (guides: ${(plan.refs ?? []).join(", ") || "none"}${plan.self ? ", their face" : ""})`);
  const refs = (plan.refs ?? []).map((n) => usable[n - 1]).filter(Boolean).map((p) => path.join(photoDir(c.id), p.file));
  if (plan.self && face) refs.unshift(face);
  let file = `${MADE}/${Date.now()}.jpg`;
  let maker = gemini ? GEMINI_IMAGE_MODEL : "local RealVisXL";
  const logIt = (extra) => {
    writeJson(madeLogFile(c.id), [...readMadeLog(c.id), {
      file, want, prompt: plan.prompt, guides: refs.map((f) => path.basename(f)), maker, at: new Date().toISOString(), ...extra,
    }]);
    copyMadeToDesktop(c);
  };
  if (gemini) {
    try {
      const img = await geminiPicture(plan.prompt, refs.slice(0, 4));
      if (img.mime === "image/png") file = file.replace(/\.jpg$/, ".png");
      fs.writeFileSync(path.join(photoDir(c.id), file), Buffer.from(img.data, "base64"));
    } catch (err) {
      console.error("Gemini picture failed:", err?.message ?? err);
      logIt({ kept: false, why: String(err?.message ?? err).slice(0, 200) });
      // The graphics card takes over, unless it's busy with a call or not set up.
      if (!pictureModelReady() || call) return null;
      maker = "local RealVisXL";
      file = `${MADE}/${Date.now()}.jpg`;
    }
    if (maker === GEMINI_IMAGE_MODEL) return keepMadePhoto(c, file, logIt);
  }
  // Make room: the voice engine lets go of its multilingual model (it reloads when a friend next speaks Spanish).
  await fetch(`${chatterbox.url}/rest`, { method: "POST" }).catch(() => null);
  await pictureEngine.start();
  for (let i = 0; i < 30 && !(await pictureEngine.status()).running; i++) await new Promise((r) => setTimeout(r, 1000));
  let r = null;
  for (let i = 0; i < 20 && !r; i++) {
    r = await fetch(`${pictureEngine.url}/make`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10 * 60 * 1000),
      body: JSON.stringify({ prompt: plan.prompt, negative: PHOTO_NEGATIVE + (plan.people === false ? ", person, people, woman, man, child, face" : ""), refs: refs.slice(0, 3), out: path.join(photoDir(c.id), file) }),
    }).catch(() => null);
    if (!r) await new Promise((res) => setTimeout(res, 1000));
  }
  if (!r?.ok) return null;
  return keepMadePhoto(c, file, logIt);
}

// Checks a new picture and adds it to the album; one that doesn't pass is deleted, never sent or kept.
async function keepMadePhoto(c, file, logIt) {
  const seen = await describePhoto(c, file);
  if (!seen?.ok) {
    fs.rmSync(path.join(photoDir(c.id), file), { force: true }); // didn't pass the check: never sent or kept
    logIt({ kept: false, why: seen ? `failed the check: ${seen.desc}` : "couldn't be checked" });
    return null;
  }
  logIt({ kept: true, desc: seen.desc });
  const entry = { file, ...seen, made: true, at: new Date().toISOString() };
  writeAlbum(c.id, [...readAlbum(c.id), entry]);
  return entry;
}

// ---- Short videos (only when you ask) ----
// "send me a video of the kids at practice": an 8 to 10 second vertical clip with sound, made by Google's Gemini Omni
// Flash (about $0.10 a second, so about $1 a video) from the friend's album pictures and face, like their photos. A
// frame from the middle is checked by Claude before it's sent (the same rules as photos) and used as its preview.
// Saved in data/contacts/<id>/photos/videos/ (and copied to the Desktop's generated folder). Needs the Google AI key.
const VIDEO_MODEL = "gemini-omni-1.1-flash";
const videoDir = (id) => path.join(photoDir(id), "videos");
function ffmpegExe() {
  const bin = path.join(dir, "video", ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries");
  const exe = fs.existsSync(bin) && fs.readdirSync(bin).find((f) => /^ffmpeg.*\.exe$/i.test(f));
  return exe ? path.join(bin, exe) : "ffmpeg";
}
// The first video anywhere in Google's answer: inline base64, or a file to download.
function findVideo(v) {
  if (!v || typeof v !== "object") return null;
  const d = v.inlineData ?? v.inline_data;
  if (d?.data && /video/.test(d.mimeType ?? d.mime_type ?? "")) return { data: d.data };
  if (typeof v.data === "string" && v.data.length > 1000 && (v.type === "video" || /video/.test(v.mime_type ?? v.mimeType ?? ""))) return { data: v.data };
  if (typeof v.uri === "string" && (v.type === "video" || /video/.test(v.mime_type ?? v.mimeType ?? ""))) return { uri: v.uri };
  for (const x of Array.isArray(v) ? v : Object.values(v)) {
    const found = findVideo(x);
    if (found) return found;
  }
  return null;
}
async function geminiVideo(prompt, refs) {
  let budget = 12 * 1024 * 1024;
  const images = [];
  for (const f of refs) {
    const size = fs.statSync(f).size;
    if (size > budget) continue;
    budget -= size;
    images.push({ type: "image", mime_type: photoMime(f), data: fs.readFileSync(f).toString("base64") });
  }
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.googleKey },
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: JSON.stringify({ model: VIDEO_MODEL, input: [{ type: "text", text: prompt }, ...images], response_format: { type: "video", aspect_ratio: "9:16" }, store: false, background: false }),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Google answered ${r.status}: ${String(out?.error?.message ?? JSON.stringify(out)).slice(0, 300)}`);
  const found = findVideo(out);
  if (!found) throw new Error(`Google sent no video: ${JSON.stringify(out).slice(0, 300)}`);
  if (found.data) return Buffer.from(found.data, "base64");
  // A file link: wait until it's ready, then download it.
  for (let i = 0; i < 60; i++) {
    const d = await fetch(`${found.uri}${found.uri.includes("?") ? "&" : "?"}alt=media`, { headers: { "x-goog-api-key": config.googleKey } });
    if (d.ok && /video|octet/.test(d.headers.get("content-type") ?? "")) return Buffer.from(await d.arrayBuffer());
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error("The video never finished downloading.");
}
async function friendVideo(c, want) {
  if (spicyOn(c)) {
    const plan = await spicyPlan(c, want, "video");
    const spicy = plan ? await spicyVideo(c, want, plan).catch((err) => (console.error("Spicy video failed:", err?.message ?? err), null)) : null;
    if (spicy) return spicy;
  }
  if (!config.googleKey || config.airplane) throw new Error("Videos need a Google AI key (Settings → Account).");
  const album = (await syncAlbum(c)).filter((p) => p.ok);
  const face = faceFile(c.settings.face);
  let persona = "";
  try { persona = fs.readFileSync(path.join(personasDir, c.id, "persona.md"), "utf8").split(PHONE_RULES_HEADING)[0].slice(0, 2500); } catch {}
  const first = firstName(c);
  const plan = await askJson([{ type: "text", text: `${persona || c.name}

${c.name} wants to send a short phone video they just shot: "${want}".
${looksOf(c) ? `What ${first} looks like: ${looksOf(c)}.\n` : ""}Pictures in their camera roll:
${album.map((p, i) => `${i + 1}. ${p.desc}`).join("\n") || "(none)"}
${madeLessons(c.id)}${PHOTO_RULES}
Write a prompt for a video model that is also given the camera-roll pictures you pick (and their face picture, if their face shows) as references. Say to keep everyone looking exactly like the references. Then describe an 8 to 10 second vertical smartphone video, handheld, natural light, realistic, with natural sound (voices, the place), and what happens in it, second by second if it helps. Anyone in it is described concretely (age, skin tone, hair, clothes; ${first} exactly as described above). Pick up to 3 camera-roll pictures showing the same people, place or things. If it can't be made within the rules, give an empty prompt.
Reply with only JSON: {"prompt": "...", "refs": [numbers], "self": true if ${first}'s face shows, otherwise false}` }], MEMORY_MODEL);
  if (!plan?.prompt) throw new Error("That video can't be made.");
  const refs = (plan.refs ?? []).map((n) => album[n - 1]).filter(Boolean).map((p) => path.join(photoDir(c.id), p.file));
  if (plan.self && face) refs.unshift(face);
  console.log(`Making a video for ${c.name}: ${plan.prompt}`);
  const video = await geminiVideo(plan.prompt, refs.slice(0, 4));
  fs.mkdirSync(videoDir(c.id), { recursive: true });
  const name = `${Date.now()}`;
  const file = path.join(videoDir(c.id), `${name}.mp4`);
  fs.writeFileSync(file, video);
  // Google's file is large (about 13 MB for 8 seconds); a phone-quality copy is a fraction of that.
  try {
    const small = path.join(videoDir(c.id), `${name}-small.mp4`);
    execFileSync(ffmpegExe(), ["-y", "-loglevel", "error", "-i", file, "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", small], { windowsHide: true });
    if (fileSize(small) > 0 && fileSize(small) < fileSize(file)) fs.renameSync(small, file);
    else fs.rmSync(small, { force: true });
  } catch (err) {
    console.error("Shrinking the video failed:", err?.message ?? err);
  }
  // A frame from the middle: Claude checks it, and it's the preview in the conversation.
  const poster = path.join(videoDir(c.id), `${name}.jpg`);
  try { execFileSync(ffmpegExe(), ["-y", "-loglevel", "error", "-ss", "4", "-i", file, "-frames:v", "1", "-q:v", "3", poster], { windowsHide: true }); } catch {}
  const seen = fs.existsSync(poster) ? await describePhoto(c, `videos/${name}.jpg`) : null;
  if (!seen?.ok) {
    fs.rmSync(file, { force: true });
    fs.rmSync(poster, { force: true });
    throw new Error("That video didn't pass the check.");
  }
  writeJson(madeLogFile(c.id), [...readMadeLog(c.id), { file: `videos/${name}.mp4`, want, prompt: plan.prompt, guides: refs.map((f) => path.basename(f)), maker: VIDEO_MODEL, at: new Date().toISOString(), kept: true, desc: seen.desc, video: true }]);
  try {
    const desk = desktopFolder(c);
    if (desk) { fs.mkdirSync(desk, { recursive: true }); fs.copyFileSync(file, path.join(desk, `${name}.mp4`)); }
  } catch {}
  return { url: `/api/photos/${c.id}/${encodeURIComponent(`videos/${name}.mp4`)}`, poster: `/api/photos/${c.id}/${encodeURIComponent(`videos/${name}.jpg`)}`, desc: seen.desc };
}

// ---- Spicy pictures and videos (Grok Imagine; needs the xAI key, Rated R flirting and the friend's spicy toggle) ----
// Only of the friend themself, an adult; never anyone else, and never anything with children or family (those requests
// go the normal way, by the normal rules). No album pictures are sent along (they can show kids or other people); only
// the friend's looks in words and their made-up face picture. Grok plans it, makes it and checks it (frames, for a
// video) before it's sent. Kept in photos/spicy/ (never reused for an ordinary photo) and copied to the Desktop's
// generated\spicy folder.
const SPICY_RULES = "Only the friend themself, an adult (late 20s or older, clearly grown), alone in the picture. Sexy and R-rated is fine: lingerie, topless, nude, boudoir, sensual poses. Never anyone else in it, never sex acts, never anyone who looks under 25, never anything to do with children, family or school, nothing violent or degrading, no real celebrity.";
const SPICY_IMAGE_MODEL = "grok-imagine-image-2.0";
const SPICY_VIDEO_MODEL = "grok-imagine-video-1.5";
const spicyDir = (id) => path.join(photoDir(id), "spicy");
// Grok, briefly, answering in JSON (null if it can't).
async function grokJson(content) {
  try {
    const msg = await getGrok().messages.create({ model: grokModels().main, max_tokens: 2000, messages: [{ role: "user", content }] });
    const answer = textOf(msg.content);
    return answer.includes("{") ? JSON.parse(answer.replace(/^[^{]*/, "").replace(/[^}]*$/, "")) : null;
  } catch (err) {
    console.error("Grok helper failed:", err?.message ?? err);
    return null;
  }
}
async function xai(pathname, body) {
  const r = await fetch(`https://api.x.ai/v1${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.xaiKey}` },
    signal: AbortSignal.timeout(5 * 60 * 1000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`xAI answered ${r.status}: ${String(out?.error?.message ?? out?.error ?? JSON.stringify(out)).slice(0, 300)}`);
  return out;
}
// Is this a spicy request, and if so, the prompt for it. null when it isn't (or can't be made).
async function spicyPlan(c, want, kind) {
  const first = firstName(c);
  const plan = await grokJson([{ type: "text", text: `${first} (${c.name}) is texting their adult partner a ${kind === "video" ? "short phone video" : "photo"} they just took: "${want}".
${looksOf(c) ? `What ${first} looks like: ${looksOf(c)}.\n` : ""}${madeLessons(c.id)}Rules for a spicy one: ${SPICY_RULES}
Is this request sexy or R-rated, of ${first} alone? If it involves anyone else (kids, family, friends) or is an ordinary everyday ${kind}, it's not spicy.
If it is, write a prompt for a ${kind === "video" ? "video model: an 8 second vertical smartphone video, handheld, realistic, natural light, with natural sound, and what happens in it" : "photo model: a candid, realistic smartphone selfie or phone-propped photo, natural light"}, describing ${first} exactly as above (skin tone, hair, body, age), alone, within the rules.
Reply with only JSON: {"spicy": true or false, "prompt": "..." (empty if not spicy), "self": true if ${first}'s face shows}` }]);
  return plan?.spicy && plan.prompt ? plan : null;
}
// Grok looks at a picture: what it shows, and whether it keeps the spicy rules.
async function spicyCheck(c, files) {
  const out = await grokJson([
    ...files.map((f) => ({ type: "image", source: { type: "base64", media_type: photoMime(f), data: fs.readFileSync(f).toString("base64") } })),
    { type: "text", text: `${files.length > 1 ? "These are frames from a video" : "This is a picture"} meant to show ${c.name}${looksOf(c) ? ` (${looksOf(c)})` : ""}.\nRules: ${SPICY_RULES}\nReply with only JSON: {"desc": "one plain sentence saying what it shows", "ok": false if it breaks any rule above (especially if anyone looks under 25, or more than one person shows), otherwise true}` },
  ]);
  return out && typeof out.desc === "string" ? { desc: out.desc.slice(0, 300), ok: out.ok === true } : null;
}
function logSpicy(c, entry) {
  writeJson(madeLogFile(c.id), [...readMadeLog(c.id), { ...entry, spicy: true, at: new Date().toISOString() }]);
  try {
    const desk = desktopFolder(c);
    if (desk && entry.kept) {
      const out = path.join(desk, "spicy");
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(path.join(photoDir(c.id), entry.file), path.join(out, path.basename(entry.file)));
    }
  } catch {}
}
async function spicyPhoto(c, want, plan) {
  const face = plan.self ? faceFile(c.settings.face) : null;
  console.log(`Making a spicy photo for ${c.name}: ${plan.prompt}`);
  const body = { model: SPICY_IMAGE_MODEL, prompt: plan.prompt, response_format: "b64_json", aspect_ratio: "3:4" };
  const out = await (face
    ? xai("/images/edits", { ...body, prompt: `Keep this person's face and features exactly. ${plan.prompt}`, image: { type: "image_url", url: `data:${photoMime(face)};base64,${fs.readFileSync(face).toString("base64")}` } })
    : xai("/images/generations", body)).catch((err) => {
    logSpicy(c, { file: "", want, prompt: plan.prompt, maker: SPICY_IMAGE_MODEL, kept: false, why: /moderat/i.test(err.message) ? "turned down by xAI's moderation" : String(err.message).slice(0, 200) });
    throw err;
  });
  const d = out?.data?.[0];
  const bytes = d?.b64_json ? Buffer.from(d.b64_json, "base64") : d?.url ? Buffer.from(await (await fetch(d.url)).arrayBuffer()) : null;
  if (!bytes) throw new Error(`Grok sent no picture: ${JSON.stringify(out).slice(0, 200)}`);
  fs.mkdirSync(spicyDir(c.id), { recursive: true });
  const file = `spicy/${Date.now()}.jpg`;
  fs.writeFileSync(path.join(photoDir(c.id), file), bytes);
  const seen = await spicyCheck(c, [path.join(photoDir(c.id), file)]);
  if (!seen?.ok) {
    fs.rmSync(path.join(photoDir(c.id), file), { force: true });
    logSpicy(c, { file, want, prompt: plan.prompt, maker: SPICY_IMAGE_MODEL, kept: false, why: seen ? `failed the check: ${seen.desc}` : "couldn't be checked" });
    return null;
  }
  logSpicy(c, { file, want, prompt: plan.prompt, maker: SPICY_IMAGE_MODEL, kept: true, desc: seen.desc });
  return { url: `/api/photos/${c.id}/${encodeURIComponent(file)}`, desc: seen.desc };
}
async function spicyVideo(c, want, plan) {
  console.log(`Making a spicy video for ${c.name}: ${plan.prompt}`);
  const { request_id } = await xai("/videos/generations", { model: SPICY_VIDEO_MODEL, prompt: plan.prompt, duration: 8, aspect_ratio: "9:16", resolution: "720p" });
  let done = null;
  for (let i = 0; i < 120 && !done; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    const st = await xai(`/videos/${request_id}`);
    if (st.status === "done") done = st;
    else if (st.status === "failed" || st.status === "expired") throw new Error(`Grok's video failed: ${st.error?.message ?? st.status}`);
  }
  if (!done?.video?.url) throw new Error("Grok's video never finished.");
  fs.mkdirSync(spicyDir(c.id), { recursive: true });
  const name = `${Date.now()}`;
  const file = path.join(spicyDir(c.id), `${name}.mp4`);
  fs.writeFileSync(file, Buffer.from(await (await fetch(done.video.url)).arrayBuffer()));
  // Three frames are checked; the middle one is the preview.
  const frames = [1, 4, 7].map((t) => path.join(spicyDir(c.id), `${name}-${t}.jpg`));
  frames.forEach((f, i) => { try { execFileSync(ffmpegExe(), ["-y", "-loglevel", "error", "-ss", String([1, 4, 7][i]), "-i", file, "-frames:v", "1", "-q:v", "3", f], { windowsHide: true }); } catch {} });
  const shot = frames.filter((f) => fs.existsSync(f));
  const seen = shot.length ? await spicyCheck(c, shot) : null;
  const poster = path.join(spicyDir(c.id), `${name}.jpg`);
  if (fs.existsSync(frames[1])) fs.renameSync(frames[1], poster);
  for (const f of frames) fs.rmSync(f, { force: true });
  if (!seen?.ok) {
    fs.rmSync(file, { force: true });
    fs.rmSync(poster, { force: true });
    logSpicy(c, { file: `spicy/${name}.mp4`, want, prompt: plan.prompt, maker: SPICY_VIDEO_MODEL, kept: false, video: true, why: seen ? `failed the check: ${seen.desc}` : "couldn't be checked" });
    throw new Error("That video didn't pass the check.");
  }
  logSpicy(c, { file: `spicy/${name}.mp4`, want, prompt: plan.prompt, maker: SPICY_VIDEO_MODEL, kept: true, video: true, desc: seen.desc });
  return { url: `/api/photos/${c.id}/${encodeURIComponent(`spicy/${name}.mp4`)}`, poster: `/api/photos/${c.id}/${encodeURIComponent(`spicy/${name}.jpg`)}`, desc: seen.desc };
}

// The picture a friend texts for [photo: ...]: the best album match, or a new one. null if neither works.
// With spicy pictures on, a sexy one of just them is made by Grok instead. If Grok won't (xAI's moderation turns down
// a lot), an ordinary photo is sent the usual way.
async function friendPhoto(c, want) {
  if (spicyOn(c)) {
    const plan = await spicyPlan(c, want, "photo");
    const spicy = plan ? await spicyPhoto(c, want, plan).catch((err) => (console.error("Spicy photo failed:", err?.message ?? err), null)) : null;
    if (spicy) return spicy;
  }
  const album = (await syncAlbum(c)).filter((p) => p.ok);
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const fresh = album.filter((p) => !(p.sentAt && Date.parse(p.sentAt) > week)); // not one they sent this week
  let pick = null;
  if (fresh.length) {
    const out = await askJson([{ type: "text", text: `Someone wants to text a photo of: "${want}". Their camera roll:\n${fresh.map((p, i) => `${i + 1}. ${p.desc}`).join("\n")}\nWhich picture would they send for that? It must show what was asked for (the same place or activity, and the same people or things); small differences, like a different outfit or angle, are fine. Reply with only JSON: {"pick": its number, or 0 if none shows that}` }]);
    pick = fresh[(out?.pick ?? 0) - 1] ?? null;
  }
  pick ??= await makePhoto(c, want, album);
  if (!pick) return null;
  writeAlbum(c.id, readAlbum(c.id).map((p) => (p.file === pick.file ? { ...p, sentAt: new Date().toISOString() } : p)));
  return { url: `/api/photos/${c.id}/${encodeURIComponent(pick.file)}`, desc: pick.desc };
}

// Builds the conversation for the model from recent texts (alternating turns, starting and ending with the buddy).
function textTurns(list, extra) {
  const turns = [];
  for (const t of list.slice(-40)) {
    const role = t.from === "me" ? "user" : "assistant";
    const line = t.vm ? `(You missed their call. They left you a voicemail:) ${t.text}` : t.video ? `[video: ${t.video.desc}]` : t.photo ? `[photo: ${t.photo.desc}]` : t.gif ? (t.from === "me" ? `(sends a GIF: ${gifWords(t.gif)})${t.text ? `\n${t.text}` : ""}` : `[gif: ${t.gif.title}]`) : t.text;
    if (turns.at(-1)?.role === role) turns.at(-1).content += `\n${line}`;
    else turns.push({ role, content: line });
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "(Earlier texts.)" });
  if (extra) {
    if (turns.at(-1)?.role === "user") turns.at(-1).content += `\n\n${extra}`;
    else turns.push({ role: "user", content: extra });
  }
  return turns;
}

// What people text about on their own, by relationship (from how families and friends really text: moms check in and
// send good-morning texts, sisters send jokes and "can you believe" gossip, best friends vent and make plans,
// grandparents send rare, sweet, formal notes). friend.json "textHabits" adds their own. One is picked at random.
const TEXT_HABITS = {
  mom: ["a good morning or goodnight text", "asking if they've eaten or are taking care of themselves", "a reminder about something (an appointment, calling family)", "sharing a recipe, article or photo description", "a quick 'love you, thinking of you'"],
  dad: ["a short dad joke or one-liner", "a comment about the weather or a game", "a practical reminder (car, bills, the furnace)"],
  spouse: ["what's for dinner", "a quick 'love you'", "asking them to grab something on the way home", "a funny thing that happened today"],
  sister: ["a random joke or funny thing that just happened", "juicy gossip: 'can you BELIEVE...'", "venting about someone being dramatic", "asking their opinion on something (an outfit, a gift, a text she got)", "an eye-roll update about the family"],
  brother: ["lightly roasting them", "a funny thing he saw", "sports talk", "asking if they want to do something"],
  "best-friend": ["a random funny observation, like describing a meme", "venting about their day", "making plans", "checking on something the buddy told them", "'omg you will not believe this'"],
  "girlfriend-bestie": ["'omg you will not believe this'", "venting about her day", "hyping her up or a compliment", "making plans for girls' night", "checking on something she told you", "a funny thing that happened"],
  "close-friend": ["checking in", "sharing something that reminded them of the buddy", "making plans"],
  "romantic-interest": ["a flirty good-morning or goodnight text", "'thinking about you'", "a playful tease", "asking how their day is going", "a compliment out of nowhere", "'missing you'"],
  friend: ["checking in", "sharing something that reminded them of the buddy"],
  "family-friend": ["a warm check-in and asking after the family"],
  cousin: ["family gossip", "a funny memory from when you were kids", "a check-in"],
  aunt: ["a sweet check-in", "family news"],
  uncle: ["a bad joke", "a sports comment"],
  grandparent: ["a sweet, formal check-in, signed like a letter", "the weather where they live", "asking when they'll visit"],
  neighbor: ["a neighborhood heads-up (a package, trash day, the weather)"],
  coworker: ["work gossip or a complaint about a meeting"],
};
// Texts on their own per day the app is open (~8 hours), by relationship; friend.json "textScale" adjusts it.
const TEXTS_PER_DAY = {
  mom: 2, dad: 0.7, spouse: 3, sister: 3, brother: 1.5, "best-friend": 3, "girlfriend-bestie": 3.5, "close-friend": 1.5,
  friend: 0.7, "family-friend": 0.4, cousin: 1, aunt: 0.5, uncle: 0.5, grandparent: 0.5, neighbor: 0.3, coworker: 0.4,
  "romantic-interest": 2.5,
};
function textHabit(c) {
  const own = c.textHabits ?? catalogEntry(c.id)?.textHabits ?? [];
  const pics = photoHabits(c) ? [`sending a photo (${photoHabits(c)})`] : [];
  const pool = [...(TEXT_HABITS[c.role] ?? TEXT_HABITS.friend), ...own, ...own, ...pics]; // their own habits come up more
  return pool[Math.floor(Math.random() * pool.length)];
}
const textsPerDay = (c) => (TEXTS_PER_DAY[c.role] ?? 0.7) * (c.textScale ?? catalogEntry(c.id)?.textScale ?? 1);

// Asks the friend for their next text(s). opener: they're texting first; about: what prompted it.
async function friendTexts(c, { opener = false, about = null, noPhoto = false, late = null, direct = null } = {}) {
  const list = readTexts(c.id);
  const thread = currentThread(list);
  const mine = thread.filter((t) => t.from === "me").length;
  const wantsCall = !direct && !opener && !c.support && mine >= textsBeforeCall(c); // Support never rings you
  const note = direct ?? (opener
    ? `(You decide to text your buddy, on your own. What prompted it: ${about ?? textHabit(c)}. Text the way you would. Just the text.)`
    : wantsCall
      ? `(This text conversation has gone on a while, and you'd rather just talk. Text that you're calling, in your own style, and end with ${CALL_MARK}.)`
      : null);
  const noPhotoNote = noPhoto ? "(You can't send a photo or video right now. Text without one, and don't say you're sending or sent one.)" : null;
  const waited = late?.since ? Date.now() - Date.parse(late.since) : 0;
  const ago = waited > 90 * 60 * 1000 ? `${Math.round(waited / 3600000)} hours` : `${Math.round(waited / 60000)} minutes`;
  const lateNote = !opener && waited > 20 * 60 * 1000
    ? `(It's been ${ago} since your buddy's text${late.what && late.what !== "free" ? `; you couldn't get to your phone because you were ${late.what}` : ""}. Answer naturally, and mention why you're late only if it fits, briefly.)`
    : null;
  const model = chatModel(c);
  const msg = await model.client.beta.messages.create({
    model: model.id,
    max_tokens: 1500,
    output_config: { effort: "low" },
    ...model.params,
    system: `${await systemPrompt(c)}\n\n${TEXTING}${noPhoto || c.support ? "" : photoRules(c)}`,
    messages: textTurns(list, [note, lateNote, noPhotoNote].filter(Boolean).join("\n\n") || null),
  });
  if (msg.stop_reason === "refusal") throw new Error("They couldn't text back right now.");
  let raw = untag(textOf(msg.content));
  const call = !direct && raw.includes(CALL_MARK); // a direct /ai request never turns into a call
  raw = raw.replaceAll(CALL_MARK, "");
  // A tapback on your last text: [react: 😂]
  let reaction = null;
  raw = raw.replace(/\[react:\s*([^\]]{1,16})\]\s*/i, (_, e) => { reaction = e.trim(); return ""; });
  const parts = raw.replace(/\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\]]*\]\s*/g, "").split(/^\s*---\s*$/m).map((t) => t.trim()).filter(Boolean).slice(0, 3);
  const now = Date.now();
  const added = [];
  for (const [i, part] of parts.entries()) {
    const entry = { id: `${now + i}`, from: "them", text: part, at: new Date(now + i).toISOString(), read: false };
    // A GIF they send: [gif: search words] on its own line, looked up on GIPHY (dropped without a key).
    const ph = part.match(/\[photo:\s*([^\]]+)\]/i);
    if (ph && noPhoto) entry.text = part.replace(/\[photo:[^\]]*\]/gi, "").trim();
    else if (ph) {
      const photo = await friendPhoto(c, ph[1].trim()).catch((err) => (console.error("Photo failed:", err?.message ?? err), null));
      if (!photo) return friendTexts(c, { opener, about, late, direct, noPhoto: true }); // nothing sent yet: text again without it
      const words = part.replace(/\[photo:[^\]]*\]/gi, "").trim();
      if (words) added.push({ ...entry, id: `${now + i}-t`, text: words });
      Object.assign(entry, { text: "", photo });
    }
    if (!entry.text && !entry.photo && !entry.video && !part.match(/^\[gif:/i)) continue;
    const vid = part.match(/\[video:\s*([^\]]+)\]/i);
    if (vid) {
      const video = noPhoto ? null : await friendVideo(c, vid[1].trim()).catch((err) => (console.error("Video failed:", err?.message ?? err), null));
      if (!video) return friendTexts(c, { opener, about, late, direct, noPhoto: true });
      const words = part.replace(/\[video:[^\]]*\]/gi, "").trim();
      if (words) added.push({ ...entry, id: `${now + i}-t`, text: words });
      Object.assign(entry, { text: "", video });
    }
    const g = part.match(/^\[gif:\s*([^\]]+)\]$/i);
    if (g) {
      const found = await searchGifs(g[1].trim(), 5).catch(() => []);
      if (!found.length) continue;
      const pick = found[Math.floor(Math.random() * found.length)];
      Object.assign(entry, { text: "", gif: { url: pick.url, title: pick.title } });
    }
    added.push(entry);
  }
  const all = readTexts(c.id);
  if (reaction) {
    const mine = all.findLast((t) => t.from === "me");
    if (mine) mine.reaction = reaction;
  }
  writeTexts(c.id, [...all, ...added]);
  if (!c.support && readTexts(c.id).filter((t) => !t.remembered).length >= 20) rememberTexts(c).catch(() => {}); // Support keeps no memory
  return { texts: added, call, reaction };
}

// Texts not yet in the memory notes, as transcript lines; marks them remembered.
function takeUnrememberedTexts(c) {
  const list = readTexts(c.id);
  const fresh = list.filter((t) => !t.remembered);
  if (!fresh.length) return "";
  for (const t of fresh) t.remembered = true;
  writeTexts(c.id, list);
  const first = firstName(c);
  return fresh.map((t) => `[text ${textWhen(t.at)}] ${t.from === "me" ? "Buddy" : first}: ${t.vm ? `(voicemail) ${t.text}` : t.video ? `(video: ${t.video.desc})` : t.photo ? `(photo: ${t.photo.desc})` : t.gif ? `(GIF: ${gifWords(t.gif)})` : t.text}`).join("\n");
}
async function rememberTexts(c) {
  const transcript = takeUnrememberedTexts(c);
  if (!transcript) return;
  const memory = loadContact(c.id)?.memory;
  if (!memory) return;
  await mergeMemory(c, memory, `(Text messages)\n${transcript}`, "recent texts");
  await learnRules(c, memory, transcript);
  if (fs.existsSync(path.join(contactsDir, c.id))) writeJson(contactPath(c.id, "memory.json"), memory);
}

// Recent texts, so a call picks up where the texting left off.
function recentTexts(c) {
  const since = Date.now() - 2 * 24 * 3600 * 1000;
  const recent = readTexts(c.id).filter((t) => Date.parse(t.at) > since).slice(-12);
  if (!recent.length) return "";
  const first = firstName(c);
  return `\n\n# Recent texts with your buddy\n` + recent.map((t) => `- ${textWhen(t.at)}, ${t.from === "me" ? "buddy" : first}: ${t.photo ? `(photo: ${t.photo.desc})` : t.text}`).join("\n");
}

// ---- Voicemail ----
// When a friend rings and you miss or decline, they leave a voicemail: written in character (with their memory and
// briefing), spoken in their cloned voice, and saved in data/contacts/<id>/voicemail/ with an index.json. They
// remember the last few they left, and whether you've listened.
const voicemailDir = (id) => path.join(contactsDir, id, "voicemail");
const readVoicemails = (id) => readJson(path.join(voicemailDir(id), "index.json"), []);
const keptVoicemails = (id) => readVoicemails(id).filter((v) => !v.deleted); // ones you haven't deleted
const writeVoicemails = (id, list) => writeJson(path.join(voicemailDir(id), "index.json"), list);

function voicemailsLeft(c) {
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // Deleted ones count too: deleting removes the audio from your phone, not what they said.
  const recent = readVoicemails(c.id).filter((v) => v.text && Date.parse(v.at) > week).slice(-3);
  if (!recent.length) return "";
  return `\n\n# Voicemails you left your buddy\n` + recent.map((v) =>
    `- ${v.when} (${v.heard ? "they've listened to it" : "they haven't listened yet"}): "${v.text}"`).join("\n");
}

// ---- Your voicemails to friends ----
// When a friend doesn't pick up, you hear their voicemail greeting, then the beep, and you can leave a message. It's
// saved with your texts (hidden from the thread) so they remember it, and their follow-up answers it.
// The greeting is made ahead of time, in the background: written in character and spoken in their cloned voice
// (data/contacts/<id>/greeting.wav) when they're installed, and made again when their persona or voice changes
// (vmGreetingFor remembers which persona and voice it was made from).
const greetingKey = (c) => `${identitySource(c).hash}:${c.settings.cbVoice ?? ""}`;
const greetingsMaking = new Set();
async function ensureGreeting(c) {
  if (!c || c.support || greetingsMaking.has(c.id) || !getClient() || !voiceFile(c.settings.cbVoice)) return;
  if (c.vmGreetingFor === greetingKey(c) && fs.existsSync(contactPath(c.id, "greeting.wav"))) return;
  greetingsMaking.add(c.id);
  try {
    const fresh = loadContact(c.id);
    const personaChanged = (fresh.vmGreetingFor ?? "").split(":")[0] !== identitySource(fresh).hash;
    if (personaChanged) delete fresh.vmGreeting; // a new persona gets a new greeting; a new voice re-speaks the old one
    fs.rmSync(contactPath(c.id, "greeting.wav"), { force: true });
    fresh.vmGreetingFor = greetingKey(fresh);
    saveContact(fresh);
    const g = await voicemailGreeting(loadContact(c.id));
    if (!g.file) { const again = loadContact(c.id); delete again.vmGreetingFor; saveContact(again); } // try again later
    else console.log(`Recorded ${c.name}'s voicemail greeting`);
  } catch (err) {
    console.error(`${c.name}'s voicemail greeting failed:`, err?.message ?? err);
  } finally {
    greetingsMaking.delete(c.id);
  }
}
// Any friend missing a current greeting gets one, one at a time (at startup and hourly).
async function ensureGreetings() {
  for (const c of listContacts()) await ensureGreeting(c);
}
setTimeout(() => ensureGreetings().catch(() => {}), 20000);
setInterval(() => ensureGreetings().catch(() => {}), 60 * 60 * 1000);

async function voicemailGreeting(c) {
  const file = contactPath(c.id, "greeting.wav");
  if (!c.vmGreeting) {
    let persona = "";
    try { persona = fs.readFileSync(path.join(personasDir, c.id, "persona.md"), "utf8").split(PHONE_RULES_HEADING)[0].slice(0, 3000); } catch {}
    const out = await askJson([{ type: "text", text: `${persona || c.name}

Write the voicemail greeting ${c.name} recorded on their own phone, in their own voice and style: one or two short sentences, the kind people really record ("Hey, it's Joe. Leave me a message and I'll get back to ya."). Just the words they say.${LANGS[c.speaks] ? ` If they'd say a word in ${LANGS[c.speaks]}, wrap it in <${c.speaks}>...</${c.speaks}>.` : ""} Reply with only JSON: {"greeting": "..."}` }]);
    if (!out?.greeting) return { text: `Hi, you've reached ${firstName(c)}. Leave a message.`, file: null };
    const fresh = loadContact(c.id);
    fresh.vmGreeting = String(out.greeting).slice(0, 400);
    saveContact(fresh);
    c.vmGreeting = fresh.vmGreeting;
    fs.rmSync(file, { force: true });
  }
  if (!fs.existsSync(file)) {
    const voice = voiceFile(c.settings.cbVoice);
    if (!voice) return { text: untag(c.vmGreeting), file: null };
    await chatterbox.start();
    for (let i = 0; i < 60 && !(await chatterbox.status()).ready; i++) await new Promise((r) => setTimeout(r, 1000));
    const r = await fetch(`${chatterbox.url}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: c.vmGreeting, voice_path: voice }) }).catch(() => null);
    if (!r?.ok) return { text: untag(c.vmGreeting), file: null };
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return { text: untag(c.vmGreeting), file };
}

async function leaveVoicemail(c, declined) {
  const model = chatModel(c);
  const msg = await model.client.beta.messages.create({
    model: model.id,
    max_tokens: 4000,
    output_config: { effort: "low" },
    ...model.params,
    system: await systemPrompt(c),
    messages: [{
      role: "user",
      content: `(You just called your buddy and they ${declined ? "declined the call, so they're probably busy" : "didn't pick up"}. ` +
        `It went to voicemail. Leave a message after the beep the way you really would: say it's you, why you called, and ask them to call you back. ` +
        `Two to four sentences. Just the words you'd say, nothing else.)`,
    }],
  });
  if (msg.stop_reason === "refusal") throw new Error("They couldn't leave a message this time.");
  const spoken = textOf(msg.content).replaceAll(HANGUP, "").replace(/\s+/g, " ").trim();
  const text = untag(spoken);
  if (!text) throw new Error("The voicemail came out empty.");

  const file = voiceFile(c.settings.cbVoice);
  if (!file) throw new Error(`${c.name} needs a voice clip to leave a voicemail.`);
  await chatterbox.start();
  const r = await fetch(`${chatterbox.url}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: spoken.slice(0, 1000), voice_path: file }),
  });
  if (!r.ok) throw new Error(`Couldn't record the voicemail (voice engine answered ${r.status}).`);
  const audio = Buffer.from(await r.arrayBuffer());

  const at = new Date();
  const id = at.toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(voicemailDir(c.id), { recursive: true });
  fs.writeFileSync(path.join(voicemailDir(c.id), `${id}.wav`), audio);
  const entry = {
    id, at: at.toISOString(), text, heard: false, declined: !!declined,
    when: at.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }),
  };
  writeVoicemails(c.id, [...readVoicemails(c.id), entry]);
  return entry;
}

const LOOKING_THINGS_UP = `# Looking things up
You can check real, current information with your tools: football scores and news, the weather anywhere, or a web search if you have one. Use them when your buddy asks about something current or you'd need facts you don't know, like a score, a forecast, a price or a recipe you don't know by heart.
Before you use a tool, say one short natural line out loud first, like "Hang on, let me look" or "Let me grab the paper." Say it only once, and don't narrate the searching itself (no "let me see what came back" or "let me look closer"). Then tell your buddy what you found the way a person would on the phone: the gist in a sentence or two, in your own words and with your own opinion. No lists, no links, and don't read out whole articles.
If you can't find something, say so. Never make up scores, stats, prices or forecasts.`;

// Friends can hang up. The marker is stripped from what's spoken and shown; the call screen hangs up after the
// friend finishes their goodbye.
const HANGUP = "<hangup>";
// Rules about how the buddy wants to be treated, learned after each call (memory.json "rules"). They outrank the
// persona's habits; the friend stays themselves and adjusts, the way a real friend learns your boundaries.
function treatment(c) {
  const rules = c.memory.rules?.trim();
  return `# How your buddy wants to be treated\n` +
    (rules ? `${rules}\nThese come from your buddy. They outrank your usual habits, but you're still you.\n` : "") +
    `If your buddy tells you something you said wasn't nice, wasn't funny, or wasn't okay, apologize briefly and sincerely, change course, and don't do it again. If they give you permission for something (like calling them anytime), take them at their word.`;
}

// When you've missed this friend's calls lately (memory.json "missed"), they know it, and some worry.
function missedCalls(c) {
  const m = c.memory.missed;
  if (!m?.count) return "";
  return `# Calls your buddy didn't answer\nYou've called your buddy ${m.count} time${m.count === 1 ? "" : "s"} lately without getting through, most recently ${m.last}. ` +
    `React the way you naturally would, given who you are to them: relief, worry, teasing, or not a big deal.`;
}

const TEXTING_DURING_CALL = `# Texting during the call
Like on a real phone, you can text your buddy while you talk when it's handy: an address, a phone number, a recipe, a link, or a photo you're talking about. Put a text in <text>...</text> or a photo in <photo>what the picture shows</photo> anywhere in your reply. It goes to their phone and isn't said out loud, so also say something like "I'm texting it to you now." Only now and then, when it really fits.`;
// What the friend texted during the call: sent to the phone, picked up by the page through /api/updates.
async function textsDuringCall(c, said) {
  const words = [...said.matchAll(/<text>([\s\S]*?)<\/text>/g)].map((m) => untag(m[1]).trim()).filter(Boolean);
  const pics = [...said.matchAll(/<photo>([\s\S]*?)<\/photo>/g)].map((m) => m[1].trim()).filter(Boolean);
  if (!words.length && !pics.length) return;
  const added = [];
  const entry = (extra) => ({ id: `${Date.now()}-${added.length}`, from: "them", text: "", at: new Date().toISOString(), read: false, ...extra });
  for (const w of pics) {
    const photo = await friendPhoto(c, w).catch(() => null);
    if (photo) added.push(entry({ photo }));
  }
  for (const w of words) added.push(entry({ text: w }));
  if (!added.length) return;
  writeTexts(c.id, [...readTexts(c.id), ...added]);
  pushUpdate({ type: "texts", contact: c.id, texts: added });
}

const ENDING_THE_CALL = `# Ending the call
You can hang up, like on a real phone, but end calls the way people really do: goodbyes go back and forth. When things are winding down, say your goodbye (the "alright, well, I'll let you go" part) without hanging up, and let your buddy answer. Only once they've said bye back, or they clearly said they have to go and you've answered, reply with a short last line ("Bye now!", "Talk soon, love ya") and put ${HANGUP} at the very end of it. It's a signal, not something you say.
Never put ${HANGUP} after a long goodbye your buddy hasn't answered yet. Don't hang up during a pause, in the middle of a conversation, or while your buddy is upset or struggling. If you're not sure the call is over, don't hang up. Keep talking or ask if they need to go.`;

// ---- You: your name, whether you're a man or a woman, and your town (first-time setup, or Settings -> You) ----
// An age given in setup, a year older for every year since.
const ageNow = (p) => (p?.age ? p.age + (new Date().getFullYear() - (p.ageYear ?? new Date().getFullYear())) : null);
function aboutBuddy(c) {
  const u = config.user;
  if (!u?.first) return "";
  const who = `${u.first}${u.last ? ` ${u.last}` : ""}`;
  return `# Your buddy\nYour buddy is ${who}, ${u.gender === "woman" ? "a woman" : "a man"}${ageNow(u) ? `, ${ageNow(u)} years old` : ""}${u.home ? `, who lives in ${u.home}` : ""}. ` +
    (u.birthday ? `Their birthday is ${dayName(u.birthday)}. ` : "") +
    `You know them, so use their first name now and then, the way you naturally would.` + aboutSpouse(c) + aboutFamily(c) +
    (u.avoid ? `\nNever bring up: ${u.avoid}` : "");
}

// ---- Your spouse (setup, or Settings -> You) ----
// Family and close friends know them well: what you said about them in setup, what you've mentioned on calls and texts
// (config.user.spouse.notes, learned after each call), and their important dates. Everyone else just knows the name.
const KNOWS_SPOUSE_WELL = new Set(["mom", "dad", "sister", "brother", "grandparent", "aunt", "uncle", "cousin",
  "best-friend", "girlfriend-bestie", "close-friend", "family-friend"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayName = (md) => `${MONTHS[Number(md.slice(0, 2)) - 1]} ${Number(md.slice(3))}`;
function spouseDates(sp) {
  return [
    ...(sp.birthday ? [{ what: `${sp.name}'s birthday`, date: sp.birthday }] : []),
    ...(sp.anniversary ? [{ what: "their wedding anniversary", date: sp.anniversary }] : []),
    ...(sp.dates ?? []).filter((d) => /^\d{2}-\d{2}$/.test(d.date)),
  ];
}
function aboutFamily(c) {
  const fam = config.user?.family ?? [];
  if (!fam.length) return "";
  if (!KNOWS_SPOUSE_WELL.has(c?.role)) return `\nTheir family includes ${fam.map((f) => `${f.name} (${f.relation || "family"})`).join(", ")}.`;
  return `\nTheir family:\n` + fam.map((f) => `- ${f.name}, ${f.relation || "family"}${f.age ? `, ${f.age}` : ""}${f.birthday ? `, birthday ${dayName(f.birthday)}` : ""}${f.lives ? `, lives in ${f.lives}` : ""}${f.notes ? `: ${f.notes}` : ""}`).join("\n") +
    ((config.user?.pets ?? []).length ? `\nPets: ${config.user.pets.map((x) => `${x.name}${x.kind ? ` (${x.kind})` : ""}`).join(", ")}.` : "") +
    (config.user?.notes ? `\nAlso: ${config.user.notes}` : "");
}
function aboutSpouse(c) {
  const sp = config.user?.spouse;
  if (!sp?.name || sp.married === false) return "";
  const role = sp.gender === "man" ? "husband" : "wife";
  let text = `\n\nYour buddy is married to ${sp.name}, their ${role}${ageNow(sp) ? ` (${ageNow(sp)})` : ""}.`;
  if (!KNOWS_SPOUSE_WELL.has(c?.role)) return text;
  if (sp.about) text += ` What you know about ${sp.name}: ${sp.about}`;
  if (sp.notes) text += `\nWhat your buddy has mentioned about ${sp.name}:\n${sp.notes}`;
  const dates = spouseDates(sp);
  if (dates.length) text += `\nDates you keep track of: ${dates.map((d) => `${d.what}, ${dayName(d.date)}`).join("; ")}.`;
  return text;
}

// Reminders: a week before (time to plan a gift), the day before, and the day of, the closest friend who'd do it
// (a sister first, then mom, best friends...) texts a reminder. Checked hourly while the app is open, 9 AM to 8 PM.
const REMINDER_ORDER = ["sister", "mom", "girlfriend-bestie", "best-friend", "brother", "dad", "close-friend", "grandparent",
  "aunt", "cousin", "uncle", "family-friend"];
setInterval(() => {
  const u = config.user;
  const hour = new Date().getHours();
  if (u?.birthday && hour >= 9 && hour < 20 && Date.now() - lastPing < 90 * 1000 && getClient() && !config.airplane) {
    const now = new Date();
    const md = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (md === u.birthday) {
      const friend = listContacts().find((c) => c.active !== false && KNOWS_SPOUSE_WELL.has(c.role) && !u.greeted?.[`${c.id}|${now.getFullYear()}`]);
      if (friend) {
        u.greeted = { ...(u.greeted ?? {}), [`${friend.id}|${now.getFullYear()}`]: true };
        writeJson(configFile, config);
        friendTexts(friend, { opener: true, about: `it's your buddy's birthday today${ageNow(u) ? ` (they're turning ${ageNow(u)})` : ""}. Wish them a happy birthday your way.` })
          .catch((err) => console.error("Birthday text failed:", err?.message ?? err));
        return;
      }
    }
  }
  const sp = config.user?.spouse?.married === false ? null : config.user?.spouse;
  const familyDates = (config.user?.family ?? []).filter((f) => f.birthday).map((f) => ({ what: `${f.name}'s birthday (their ${f.relation || "family"})`, date: f.birthday }));
  if ((!sp?.name && !familyDates.length) || hour < 9 || hour >= 20 || Date.now() - lastPing > 90 * 1000 || !getClient() || config.airplane) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const d of [...(sp?.name ? spouseDates(sp) : []), ...familyDates]) {
    let next = new Date(today.getFullYear(), Number(d.date.slice(0, 2)) - 1, Number(d.date.slice(3)));
    if (next < today) next.setFullYear(next.getFullYear() + 1);
    const days = Math.round((next - today) / 864e5);
    if (![7, 1, 0].includes(days)) continue;
    const key = `${d.what}|${next.getFullYear()}|${days}`;
    if (config.user.reminded?.[key] || sp?.reminded?.[key]) continue;
    const friend = listContacts()
      .filter((c) => c.active !== false && REMINDER_ORDER.includes(c.role) && (c.settings.textsYou ?? "sometimes") !== "never")
      .sort((a, b) => REMINDER_ORDER.indexOf(a.role) - REMINDER_ORDER.indexOf(b.role))[0];
    if (!friend) return;
    config.user.reminded = { ...(config.user.reminded ?? {}), [key]: true };
    writeJson(configFile, config);
    const when = { 7: "is a week from today", 1: "is tomorrow", 0: "is today" }[days];
    const extra = days === 7 ? " Suggest a gift or a plan, from what you know about them." : days === 1 ? " Make sure they're ready." : " Remind them to make it special.";
    friendTexts(friend, { opener: true, about: `reminding your buddy that ${d.what} ${when}.${extra}` })
      .catch((err) => console.error("Reminder text failed:", err?.message ?? err));
    return; // one reminder at a time
  }
}, 60 * 60 * 1000);

// ---- Friends you can install (Settings -> Friends, and first-time setup) ----
// Every friend in contacts/<id>/ with a friend.json (written by `tools/contact.py publish`) can be installed: their
// voice sample and face are copied into data/, and they start with a relationship you pick. Installed friends are the
// ones with data/contacts/<id>/contact.json; uninstalling deletes that folder (memory and all), so they show up as
// installable again, brand new.
const ROLE_CHOICES = [
  ["best-friend", "Best friend"], ["close-friend", "Close friend"], ["friend", "Friend"], ["distant-friend", "Distant friend"],
  ["family-friend", "Family friend"],
  ["neighbor", "Neighbor"], ["coworker", "Coworker"], ["mom", "Mom"], ["dad", "Dad"], ["sister", "Sister"],
  ["brother", "Brother"], ["grandparent", "Grandparent"], ["aunt", "Aunt"], ["uncle", "Uncle"], ["cousin", "Cousin"],
  ["spouse", "Spouse"], ["romantic-interest", "Romantic interest"],
];
// Relationships that make sense. Family by blood or marriage has a gender (a man can't be your sister) and, once you've
// talked or texted, is fixed for good: your sister can't later become your wife or your coworker. Friendships can grow
// closer or drift (best friend <-> close friend <-> friend <-> distant friend), and anyone in the friends group can be
// moved anywhere in it. Before the first call or text, anything that fits their gender is fine.
const ROLE_GENDER = { mom: "woman", sister: "woman", aunt: "woman", dad: "man", brother: "man", uncle: "man" };
const FRIEND_ROLES = new Set(["best-friend", "close-friend", "friend", "distant-friend", "family-friend", "neighbor", "coworker", "romantic-interest"]);
const hasTalked = (c) => (c.memory?.calls ?? 0) > 0 || readJson(contactPath(c.id, "texts.json"), []).length > 0;
function roleChoicesFor(gender, current, talked) {
  const fits = ROLE_CHOICES.filter(([r]) => !ROLE_GENDER[r] || !gender || ROLE_GENDER[r] === gender);
  if (!talked || !current) return fits.map(([r]) => r);
  const now = shownRole(current);
  if (!FRIEND_ROLES.has(now)) return [now]; // family and spouse are locked once you've met
  return fits.filter(([r]) => FRIEND_ROLES.has(r)).map(([r]) => r);
}
const catalogEntry = (id) => (validId(id) ? readJson(path.join(personasDir, id, "friend.json"), null) : null);
const friendGender = (c) => c.gender ?? catalogEntry(c.id)?.gender;
// Two women who are best friends get the best-girlfriend version of that relationship.
const resolveRole = (role, gender) =>
  role === "best-friend" && config.user?.gender === "woman" && gender === "woman" ? "girlfriend-bestie" : role;
const shownRole = (role) => (role === "girlfriend-bestie" ? "best-friend" : role);
const yourGender = () => (config.user?.gender === "woman" ? "woman" : "man");

function catalog() {
  return fs.readdirSync(personasDir).filter((id) => !id.startsWith("_") && catalogEntry(id) && !catalogEntry(id).support).map((id) => {
    const f = catalogEntry(id);
    return {
      id, name: f.name, about: f.about ?? "", gender: f.gender, installed: !!loadContact(id),
      hasFace: fs.existsSync(path.join(personasDir, id, "face.png")), cussing: !!f.cussing, // swearing is part of who they are
      role: shownRole(resolveRole(f.roles?.[yourGender()] ?? "friend", f.gender)), roleChoices: roleChoicesFor(f.gender, null, false),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function installFriend(id, role, cussing = false) {
  const f = catalogEntry(id);
  if (!f) throw new Error("That friend can't be installed.");
  if (loadContact(id)) throw new Error(`${f.name} is already installed.`);
  role = ROLE_CHOICES.some(([r]) => r === role) ? role : f.roles?.[yourGender()] ?? "friend";
  const folder = path.join(personasDir, id);
  const settings = { model: MODELS[f.model] ? f.model : DEFAULT_MODEL, cbVoice: `${f.name} voice` };
  if (CALLS_YOU.includes(f.callsYou) && f.callsYou !== "never") settings.callsYou = f.callsYou; // like Coop, who's clingy
  fs.mkdirSync(voicesDir, { recursive: true });
  fs.copyFileSync(path.join(folder, "voice.wav"), path.join(voicesDir, `${settings.cbVoice}.wav`));
  if (fs.existsSync(path.join(folder, "face.png"))) {
    fs.mkdirSync(facesDir, { recursive: true });
    fs.copyFileSync(path.join(folder, "face.png"), path.join(facesDir, `${f.name}.png`));
    settings.face = f.name;
  }
  // Links (like a married couple) only connect friends who are both installed.
  const links = (f.links ?? []).filter((l) => loadContact(l.id));
  fs.mkdirSync(path.join(contactsDir, id), { recursive: true });
  writeJson(contactPath(id, "contact.json"), {
    name: f.name, created: new Date().toISOString(), gender: f.gender, settings,
    role: resolveRole(role, f.gender), ...(cussing ? { cussing: true } : {}), ...(FLIRTING.includes(f.flirting) && f.flirting !== "off" ? { flirting: f.flirting } : {}), ...(LANGS[f.speaks] ? { speaks: f.speaks } : {}), ...(f.support ? { support: true } : {}), ...(f.worry ? { worry: f.worry } : {}), ...(f.knows ? { knows: f.knows } : {}), ...(links.length ? { links } : {}),
  });
  for (const l of links) {
    const other = loadContact(l.id);
    const back = catalogEntry(l.id)?.links?.find((x) => x.id === id);
    if (other && back && !(other.links ?? []).some((x) => x.id === id)) {
      other.links = [...(other.links ?? []), back];
      saveContact(other);
    }
  }
  return loadContact(id);
}

// Deletes a friend for good: memory, call logs, voicemail, news, and their copies of the voice and face. Friends
// linked to them forget the link. Their persona stays in contacts/<id>/, so they can be installed again, brand new.
function uninstallFriend(c) {
  if (call?.contactId === c.id) call = null;
  fs.rmSync(path.join(contactsDir, c.id), { recursive: true, force: true });
  const others = listContacts();
  if (c.settings.cbVoice && !others.some((o) => o.settings.cbVoice === c.settings.cbVoice)) {
    fs.rmSync(path.join(voicesDir, `${c.settings.cbVoice}.wav`), { force: true });
  }
  if (c.settings.face && !others.some((o) => o.settings.face === c.settings.face)) {
    fs.rmSync(path.join(facesDir, `${c.settings.face}.png`), { force: true });
  }
  for (const o of others) {
    if (!(o.links ?? []).some((l) => l.id === c.id)) continue;
    o.links = o.links.filter((l) => l.id !== c.id);
    if (!o.links.length) delete o.links;
    saveContact(o);
    fs.rmSync(heardFromPath(o.id, c.id), { force: true });
  }
}

// Factory reset: everything in data/ goes (friends, memory, voices, faces, looks), except your API key (and whether
// it's in airplane mode), logs and the knowledge cache. The phone then opens to first-time setup.
function factoryReset() {
  const { apiKey, airplane, giphyKey, googleKey, xaiKey } = config; // keys survive a reset
  call = null;
  client = null;
  for (const name of fs.readdirSync(dataDir)) {
    if (name.endsWith(".log") || name === "cache") continue;
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
  fs.mkdirSync(contactsDir, { recursive: true });
  setTimeout(installSupport, 0);
  config = { setupDone: false, ...(apiKey ? { apiKey } : {}), ...(giphyKey ? { giphyKey } : {}), ...(googleKey ? { googleKey } : {}), ...(xaiKey ? { xaiKey } : {}), ...(airplane ? { airplane } : {}) };
  writeJson(configFile, config);
}

// Each call in a friend's call log, oldest first. Headers look like "===== Call on Friday, October 23 at 3:02 PM ====="
// (no year), with " (they called)" when the friend rang you. Calls logged before that was added count as yours.
function callLogEntries(id) {
  let log = "";
  try { log = fs.readFileSync(contactPath(id, "call-log.txt"), "utf8"); } catch {}
  const year = new Date().getFullYear();
  const parts = log.split(/^===== Call on (.+?)( \(they called\))? =====$/m);
  const entries = [];
  for (let i = 1; i + 2 < parts.length + 1; i += 3) {
    const when = parts[i];
    const at = Date.parse(`${when.replace(/^\w+, /, "").replace(" at ", ` ${year} `)}`);
    if (Number.isNaN(at)) continue;
    entries.push({
      when, incoming: !!parts[i + 1], transcript: (parts[i + 2] ?? "").trim(),
      at: new Date(at > Date.now() + 864e5 ? at - 31536e6 : at).toISOString(),
    });
  }
  return entries;
}

// A friend you turned back on catches up on the news they'd have heard from linked friends while they were off.
async function catchUp(c, since) {
  for (const { id } of c.links ?? []) {
    const sender = loadContact(id);
    if (!sender || sender.active === false) continue;
    const calls = callLogEntries(id).filter((e) => e.at > since && e.transcript);
    if (!calls.length) continue;
    const transcript = calls.map((e) => `(Call on ${e.when})\n${e.transcript}`).join("\n\n").slice(-40000);
    await passNews(sender, transcript, c.id);
  }
}

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

// Connection rules: reusable prompts for how two connected friends relate and what they pass along, one file per
// kind of connection in contacts/_connections/. Similar relationships share a file: the relation words pick it
// ("your wife" -> married, "your mother-in-law" -> in-laws), unless the link names a type. More specific words
// come first, so "mother-in-law" isn't read as "mother".
const connectionsDir = path.join(personasDir, "_connections");
const CONNECTION_WORDS = [
  ["in-laws", /in-law/],
  ["grandparent", /grand/],
  ["married", /husband|wife|spouse|partner|fianc/],
  ["parent-child", /\b(mom|mother|dad|father|parent|son|daughter|child|kid|stepmom|stepdad)\b/],
  ["siblings", /brother|sister|sibling/],
  ["coworkers", /cowork|colleague|boss/],
  ["neighbors", /neighbo/],
  ["friends", /friend|buddy|pal/],
];
const connectionType = (link) =>
  link.type ?? CONNECTION_WORDS.find(([, words]) => words.test(String(link.relation).toLowerCase()))?.[0] ?? "friends";
function connectionRules(link, them) {
  const file = path.join(connectionsDir, `${connectionType(link)}.md`);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").replaceAll("{{them}}", them).replace(/^# .*\n+/, "").replace(/^## /gm, "### ").trim();
}

function connectionNews(c) {
  return (c.links ?? []).map((link) => {
    const other = loadContact(link.id);
    if (!other) return "";
    const them = firstName(other);
    let heard = "";
    try { heard = fs.readFileSync(heardFromPath(c.id, link.id), "utf8").trim(); } catch {}
    return `\n\n# ${other.name}, ${link.relation}\n${other.name} is ${link.relation}. Your buddy talks with ${them} too, on separate calls. You weren't on those calls, and you only know what ${them} has passed along.\n` +
      `${connectionRules(link, them)}\n` +
      (heard ? `### What ${them} has told you about your buddy\n${heard}` : `${them} hasn't passed along anything about your buddy yet.`);
  }).join("");
}

// After a call with `sender`, works out what news about the buddy would naturally reach each connected friend, given
// how they're connected and the receiver's role, and merges it into what that friend has heard.
async function passNews(sender, transcript, onlyTo = null) {
  if (!getClient()) return; // airplane mode, or no key
  for (const { id } of sender.links ?? []) {
    if (onlyTo && id !== onlyTo) continue;
    const receiver = loadContact(id);
    if (!receiver || receiver.active === false) continue;
    const link = receiver.links?.find((l) => l.id === sender.id) ?? { id: sender.id, relation: "a friend" };
    const relation = link.relation;
    const file = heardFromPath(receiver.id, sender.id);
    let before = "";
    try { before = fs.readFileSync(file, "utf8").trim(); } catch {}
    const s = firstName(sender), r = firstName(receiver);
    const rules = connectionRules(link, s).replaceAll("your buddy", "the buddy");
    try {
      const msg = await getClient().messages.create({
        model: NEWS_MODEL,
        max_tokens: 4000,
        output_config: { effort: "low" },
        system:
          `You decide what news about a person (the "buddy") would naturally travel from one of their friends to another, the way people really talk. ` +
          `${sender.name} just had a phone call with the buddy. To ${receiver.name}, ${sender.name} is ${relation}. ` +
          `How much passes between them depends mostly on their connection:\n${rules || "They're friends."}\n\n` +
          `${receiver.name}'s role in the buddy's life can only narrow that:\n${roleRules(receiver) || "A friend."}\n\n` +
          `Update the notes of what ${r} has heard from ${s} about the buddy. Include what ${s} would plausibly pass along to ${r}, and keep the concrete details that would come up in conversation, like names of people and pets, places, dates and plans. Phrase it the way ${r} would have heard it (like "${s} said Jason's been working long hours"), not as a transcript. ` +
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

// Streams the friend's next reply as plain text and records the full turn in the call history. If they use a
// lookup tool mid-reply, the server runs it and the reply continues in the same stream: the short "let me check"
// line they say first is spoken while the lookup runs.
async function streamReply(res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  const startLength = call.messages.length - 1; // where this turn's user message sits
  // Strip the hang-up marker, and texts or photos sent during the call (<text>...</text>, <photo>...</photo>, never
  // spoken), as text streams in. Markers can arrive split across chunks, so hold back any ending that could start one.
  const MARKS = [HANGUP, "<text>", "<photo>"];
  let held = "", hangingUp = false, hiding = null;
  const pass = (text) => {
    held += text;
    for (;;) {
      if (hiding) {
        const end = held.indexOf(hiding);
        if (end < 0) { held = held.slice(-(hiding.length - 1)); return; }
        held = held.slice(end + hiding.length);
        hiding = null;
        continue;
      }
      let at = -1, mark = null;
      for (const m of MARKS) { const i = held.indexOf(m); if (i >= 0 && (at < 0 || i < at)) { at = i; mark = m; } }
      if (at < 0) break;
      res.write(held.slice(0, at));
      held = held.slice(at + mark.length);
      if (mark === HANGUP) hangingUp = true;
      else hiding = mark.replace("<", "</");
    }
    let keep = 0;
    for (const m of MARKS) for (let k = Math.min(m.length - 1, held.length); k > keep; k--) if (m.startsWith(held.slice(-k))) { keep = k; break; }
    res.write(held.slice(0, held.length - keep));
    held = held.slice(held.length - keep);
  };
  try {
    var c = loadContact(call.contactId);
    const model = chatModel(c);
    const tools = c.support ? SUPPORT_TOOLS : knowledge.tools(c);
    for (let round = 0; round < 6; round++) {
      const stream = model.client.beta.messages.stream({
        model: model.id,
        max_tokens: 16000,
        output_config: { effort: "low" },
        cache_control: { type: "ephemeral" },
        ...model.params,
        ...(tools.length ? { tools } : {}),
        system: call.system,
        messages: call.messages,
      });
      for await (const event of stream) {
        // Text around a web search arrives as separate blocks; keep a space between them so sentences stay apart.
        if (event.type === "content_block_start" && event.content_block.type === "text" && event.index > 0) pass(" ");
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") pass(event.delta.text);
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        const line = "Huh, you cut out on me there, buddy. Say that again?";
        pass(line);
        call.messages.push({ role: "assistant", content: line });
        break;
      }
      call.messages.push({ role: "assistant", content: final.content });
      if (final.stop_reason === "pause_turn") continue; // a long web search; the API picks up where it left off
      const uses = final.content.filter((b) => b.type === "tool_use");
      if (final.stop_reason !== "tool_use" || !uses.length) break;
      const results = await Promise.all(uses.map((u) =>
        (c.support ? runSupportTool(u.name, u.input) : knowledge.runTool(u.name, u.input)).then(
          (content) => ({ type: "tool_result", tool_use_id: u.id, content }),
          (err) => ({ type: "tool_result", tool_use_id: u.id, content: `Couldn't get that right now: ${err.message}`, is_error: true }),
        )));
      call.messages.push({ role: "user", content: results });
      pass(" "); // keep "let me look." and what comes after it as separate sentences
    }
    if (!hiding) res.write(held);
    if (hangingUp) res.write("\u0000HANGUP");
    const said = call.messages.slice(startLength + 1).filter((m) => m.role === "assistant").map((m) => textOf(m.content)).join("\n");
    if (!c.support) textsDuringCall(c, said).catch((err) => console.error("Texting during the call failed:", err?.message ?? err));
  } catch (err) {
    console.error(err);
    call.messages.length = startLength; // drop this unanswered turn (and any lookups) so the history stays valid
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
  if (c.support) {
    const said = ended.messages.slice(1).map((m) => `${m.role === "user" ? "Caller" : firstName(c)}: ${untag(textOf(m.content)).trim()}`).join("\n");
    fs.appendFileSync(path.join(dataDir, "support-calls.txt"), `\n===== Support call with ${firstName(c)}, ${ended.started.toLocaleString("en-US")} =====\n${said}\n`);
    if (said.trim()) await afterSupportCall(said);
    return;
  }
  const first = firstName(c);
  const memory = c.memory;
  const memoryFile = contactPath(c.id, "memory.json");
  let transcript = ended.messages
    .slice(1)
    .map((m) => `${m.role === "user" ? "Buddy" : first}: ${untag(textOf(m.content)).trim()}`)
    .join("\n");
  memory.calls += 1;
  memory.lastCall = ended.started.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const direction = ended.incoming ? " (they called)" : "";
  fs.appendFileSync(contactPath(c.id, "call-log.txt"), `\n===== Call on ${memory.lastCall}${direction} =====\n${transcript}\n`);
  const texts = takeUnrememberedTexts(c);
  if (texts) transcript = `(Text messages since the last call)\n${texts}\n\n(The call)\n${transcript}`;
  if (transcript.trim()) await mergeMemory(c, memory, transcript, memory.lastCall);
  if (transcript.trim()) await learnRules(c, memory, transcript);
  delete memory.missed; // you talked, so there's nothing to worry about
  if (!fs.existsSync(path.join(contactsDir, c.id))) return; // uninstalled, or the phone was reset, during the call
  writeJson(memoryFile, memory);
  if (transcript.trim()) await passNews(c, transcript);
}

async function mergeMemory(c, memory, transcript, label) {
  const first = firstName(c);
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
        content: `Existing notes:\n${memory.notes || "(none yet)"}\n\nNewest conversation (${label}):\n${transcript}`,
      }],
    });
    if (msg.stop_reason !== "refusal") memory.notes = textOf(msg.content).trim();
  } catch (err) {
    console.error("Memory update failed:", err?.message ?? err);
  }
}

// Learns how the buddy wants to be treated (what upset them, which jokes landed, what they gave permission for) and
// any settings change they asked for, like "call me anytime". Settings changes are applied and announced as notices.
async function learnRules(c, memory, transcript) {
  const first = firstName(c);
  const sp = config.user?.spouse?.name && config.user.spouse.married !== false ? config.user.spouse : null;
  try {
    const msg = await getClient().messages.create({
      model: MEMORY_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system:
        `You keep ${c.name}'s notes on how their buddy wants to be treated. From the newest call, merge into the existing rules: ` +
        `anything the buddy said was not nice, not okay or unwelcome (topics, jokes, nicknames, tone); which of ${first}'s jokes got a laugh ("haha", "lol", "that's funny", laughing) and which fell flat (no reaction, a change of subject), as a short line on what humor works; and permissions the buddy gave ("you can call me anytime", "feel free to tease me"). ` +
        `Write short lines starting with '- ', at most 20, phrased as instructions to ${first} ("Don't joke about his weight."). Keep earlier rules unless the buddy changed their mind. ` +
        `Also decide whether the buddy changed how often ${first} may call them while the app is open: ${CALLS_YOU.map((k) => `"${k}" (${CALL_FREQ[k].label.toLowerCase()})`).join(", ")}. "Call me anytime" means daily unless they clearly want more; "stop calling so much" means a step or two less. Use null if nothing was said about it. ` +
        (sp ? `The buddy is married to ${sp.name}. Also merge everything the buddy said about ${sp.name} into the existing notes about them (likes, plans, health, gift ideas, how things are between them), as short '- ' lines, at most 30, and list any dates mentioned for ${sp.name} or the two of them (birthday, anniversary, a big event) as MM-DD. ` : "") +
        `Also, if ${first} mentioned a lasting change to their own routine (new work hours, night shifts, a new class, a trip), describe it in a few words as "scheduleChange", otherwise null. ` +
        `Answer with JSON only: {"rules": "...", "scheduleChange": null or "...", "callsYou": null or one of the values, "why": "a few words, when callsYou changes"${sp ? `, "spouseNotes": "...", "spouseDates": [{"what": "${sp.name}'s birthday", "date": "MM-DD"}]` : ""}, "buddyBirthday": null or "MM-DD" if the buddy said when their own birthday is}.`,
      messages: [{ role: "user", content: `Existing rules:\n${memory.rules || "(none yet)"}\n\n${sp ? `Existing notes about ${sp.name}:\n${sp.notes || "(none yet)"}\n\n` : ""}Newest call:\n${transcript}\n\n${first} is currently allowed to call: ${c.settings.callsYou ?? "never"}.` }],
    });
    if (msg.stop_reason === "refusal") return;
    const out = JSON.parse(textOf(msg.content).replace(/^```(json)?|```$/gm, "").trim());
    if (typeof out.rules === "string") memory.rules = out.rules.trim();
    if (typeof out.scheduleChange === "string" && out.scheduleChange.trim()) {
      reviseSchedule(c, out.scheduleChange).then((schedule) => {
        if (!schedule?.blocks.length) return;
        const fresh = loadContact(c.id);
        logChange({ what: `${first}'s schedule: ${out.scheduleChange}`, undo: { type: "schedule", id: c.id, before: fresh.schedule ?? null } });
        fresh.schedule = schedule;
        saveContact(fresh);
        addNotice(`${first}'s routine changed: ${out.scheduleChange}.`, c.id);
      }).catch(() => {});
    }
    if (/^\d{2}-\d{2}$/.test(out.buddyBirthday ?? "") && config.user && config.user.birthday !== out.buddyBirthday) {
      config.user.birthday = out.buddyBirthday;
      writeJson(configFile, config);
    }
    if (sp && config.user?.spouse === sp) {
      if (typeof out.spouseNotes === "string" && out.spouseNotes.trim()) sp.notes = out.spouseNotes.trim();
      for (const d of Array.isArray(out.spouseDates) ? out.spouseDates : []) {
        if (!/^\d{2}-\d{2}$/.test(d?.date) || !d.what) continue;
        if (spouseDates(sp).some((x) => x.date === d.date)) continue; // already known (like the birthday from setup)
        if (/birthday/i.test(d.what) && !sp.birthday) { sp.birthday = d.date; continue; } // fills the box in Settings -> You
        sp.dates = [...(sp.dates ?? []), { what: String(d.what).slice(0, 80), date: d.date }];
      }
      writeJson(configFile, config);
    }
    if (CALLS_YOU.includes(out.callsYou) && out.callsYou !== (c.settings.callsYou ?? "never")) {
      const fresh = loadContact(c.id);
      if (fresh) {
        fresh.settings.callsYou = out.callsYou;
        saveContact(fresh);
        addNotice(`${first} now calls you: ${CALL_FREQ[out.callsYou].label.toLowerCase()}${out.why ? ` (${out.why})` : ""}. Change it in their ✎ Edit.`, c.id);
      }
    }
  } catch (err) {
    console.error("Learning rules failed:", err?.message ?? err);
  }
}

// Notices for the phone's notification shade (data/notices.json), like a friend's calling setting changing.
const noticesFile = path.join(dataDir, "notices.json");
function addNotice(text, contactId) {
  const list = readJson(noticesFile, []);
  list.push({ id: Date.now().toString(36), at: new Date().toISOString(), text, contact: contactId });
  writeJson(noticesFile, list.slice(-30));
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

  if (req.method === "GET" && url.pathname === "/theme.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(fs.readFileSync(path.join(dir, "theme.js")));
  }

  // ---- Looks: wallpaper and call-screen style (see theme.js) ----
  if (url.pathname === "/api/appearance") {
    const a = { wallpaper: "classic", callStyle: "classic", v: 0, ...(config.appearance ?? {}) };
    if (req.method === "PUT") {
      const { wallpaper, callStyle, frame, ink } = await readBody(req);
      if (/^(custom|[a-z-]{1,30})$/.test(String(wallpaper ?? ""))) a.wallpaper = wallpaper;
      if (["classic", "photo"].includes(callStyle)) a.callStyle = callStyle;
      if (/^[a-z]{1,20}$/.test(String(frame ?? ""))) a.frame = frame;
      // ink: { <wallpaper>: <text color name> }
      for (const [wall, color] of Object.entries(ink && typeof ink === "object" ? ink : {})) {
        if (/^(custom|[a-z-]{1,30})$/.test(wall) && /^[a-z]{1,20}$/.test(String(color))) a.ink = { ...(a.ink ?? {}), [wall]: color };
      }
      config.appearance = a;
      writeJson(configFile, config);
    }
    return json(res, 200, a);
  }
  const wallpaperFile = path.join(dataDir, "wallpaper.jpg");
  if (url.pathname === "/api/wallpaper") {
    if (req.method === "POST") {
      const img = await readRaw(req, 15 * 1024 * 1024).catch(() => null);
      // JPEG files start with FF D8.
      if (!img || img[0] !== 0xff || img[1] !== 0xd8) return json(res, 400, { error: "That picture didn't come through. Try again." });
      fs.writeFileSync(wallpaperFile, img);
      config.appearance = { wallpaper: "classic", callStyle: "classic", ...(config.appearance ?? {}), wallpaper: "custom", v: Date.now() };
      writeJson(configFile, config);
      return json(res, 200, config.appearance);
    }
    if (!fs.existsSync(wallpaperFile)) return json(res, 404, { error: "No wallpaper picture." });
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=31536000" });
    return fs.createReadStream(wallpaperFile).pipe(res);
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(dir, "index.html")));
  }
  if (url.pathname === "/api/status") {
    return json(res, 200, {
      held: held?.contactId ?? null, hasGiphy: !!config.giphyKey, hasGoogle: !!config.googleKey, hasGrok: !!config.xaiKey, googleProblem: geminiProblem && Date.now() < geminiProblem.until ? geminiProblem.message : null, hasKey: !!config.apiKey, userBusy: userBusy(), brain: getClient()?.gemini ? "gemini" : getClient() ? "claude" : null, airplane: !!config.airplane, silent: !!config.silent, inCall: call?.contactId ?? null,
      setupDone: config.setupDone !== false, user: config.user ?? null,
    });
  }
  if (url.pathname === "/api/ping") return json(res, 200, { ok: true });

  // ---- You (first-time setup, or Settings -> You) ----
  if (req.method === "PUT" && url.pathname === "/api/profile") {
    saveProfileFrom(await readBody(req));
    return json(res, 200, config.user);
  }

  if (req.method === "GET" && url.pathname === "/api/frequencies") {
    const list = (o) => Object.entries(o).map(([id, f]) => ({ id, label: f.label }));
    return json(res, 200, { calls: list(CALL_FREQ), texts: list(TEXT_FREQ) });
  }
  // Silent mode: calls and texts still come in, without the ring or the ding.
  if (req.method === "POST" && url.pathname === "/api/silent") {
    const { on } = await readBody(req);
    if (on) config.silent = true;
    else delete config.silent;
    writeJson(configFile, config);
    return json(res, 200, { silent: !!config.silent });
  }
  if (req.method === "POST" && url.pathname === "/api/airplane") {
    const { on } = await readBody(req);
    if (on && call) return json(res, 400, { error: "Hang up first." });
    config.airplane = !!on;
    if (!config.airplane) delete config.airplane;
    client = null;
    writeJson(configFile, config);
    // Friends turned back on while in airplane mode catch up now.
    if (getClient()) {
      for (const c of listContacts().filter((x) => x.catchUpSince)) {
        const since = c.catchUpSince;
        delete c.catchUpSince;
        saveContact(c);
        catchUp(c, since).catch((err) => console.error("Catch-up failed:", err?.message ?? err));
      }
    }
    return json(res, 200, { airplane: !!config.airplane });
  }
  // Removing your key: only you, only in airplane mode, and the app asks twice first.
  if (req.method === "DELETE" && url.pathname === "/api/key") {
    const { confirm } = await readBody(req);
    if (!config.airplane) return json(res, 400, { error: "Turn on airplane mode before removing your key." });
    if (confirm !== "REMOVE") return json(res, 400, { error: "Type REMOVE to confirm." });
    delete config.apiKey;
    delete config.airplane;
    client = null;
    writeJson(configFile, config);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/setup/done") {
    config.setupDone = true;
    writeJson(configFile, config);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/system/reset") {
    const { confirm } = await readBody(req);
    if (confirm !== "RESET") return json(res, 400, { error: 'Type RESET to confirm.' });
    factoryReset();
    return json(res, 200, { ok: true });
  }

  // ---- Friends you can install ----
  if (req.method === "GET" && url.pathname === "/api/roles") {
    return json(res, 200, ROLE_CHOICES.map(([id, name]) => ({ id, name })));
  }
  if (req.method === "GET" && url.pathname === "/api/catalog") return json(res, 200, catalog());
  if (req.method === "GET" && url.pathname === "/api/catalog/face") {
    const id = url.searchParams.get("id");
    const file = validId(id) ? path.join(personasDir, id, "face.png") : null;
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: "No picture." });
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=3600" });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === "POST" && url.pathname === "/api/install") {
    const { id, role, cussing } = await readBody(req);
    try {
      const c = installFriend(id, role, cussing === true);
      // Installing is the one time you watch a friend being created: their identity is built now, so their first
      // call or text starts right away. If it can't be (no key yet), it's built in the background later.
      if (getClient() && !c.support) {
        await buildIdentity(loadContact(c.id)).catch((err) => console.error(`Building ${c.name}'s identity failed:`, err?.message ?? err));
        ensureGreeting(loadContact(c.id)); // their voicemail greeting, in the background
      }
      return json(res, 200, { id: c.id, name: c.name });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // Mic-level readings from calls, for tuning voice interrupting (data/vad.log, trimmed to the last ~500 KB).
  if (req.method === "POST" && url.pathname === "/api/vad-log") {
    const { lines = [] } = await readBody(req);
    const file = path.join(dataDir, "vad.log");
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) {
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(-500_000));
      }
      fs.appendFileSync(file, lines.slice(0, 200).map((l) => String(l).slice(0, 300)).join("\n") + "\n");
    } catch {}
    return json(res, 200, { ok: true });
  }

  // The Brain list: every model whose key works, grouped by maker. ?fresh=1 checks the keys again first.
  if (url.pathname === "/api/models") {
    if (url.searchParams.get("fresh") || [["apiKey", "claude"], ["googleKey", "google"], ["xaiKey", "grok"]].some(([k, b]) => config[k] && (!brains[b] || Date.now() - brains[b].at > 10 * 60 * 1000))) {
      await checkBrains().catch(() => {});
    }
    const side = (k, b) => ({ has: !!config[k], ok: !!config[k] && !!brains[b]?.ok, why: brains[b]?.ok === false ? brains[b].why : null });
    return json(res, 200, {
      claude: side("apiKey", "claude"), google: side("googleKey", "google"), grok: side("xaiKey", "grok"), airplane: !!config.airplane,
      models: Object.entries(MODELS).map(([key, m]) => ({ key, label: m.label, maker: m.google ? "Gemini" : m.grok ? "Grok" : "Claude", ok: modelUsable(key), twin: m.twin })),
      ...(() => {
        const c = url.searchParams.get("contact") && loadContact(url.searchParams.get("contact"));
        return c ? { ratedR: { can: ratedROk(c), family: !R_ROLES.has(c.role ?? "friend"), on: flirtingOf(c) === "rated-r", using: flirtingOf(c) === "rated-r" ? chatModel(c).label : null }, spicy: !!c.spicyMedia } : {};
      })(),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/key") {
    const { key } = await readBody(req);
    const test = new Anthropic({ apiKey: (key || "").trim() });
    try {
      await test.models.retrieve(MODELS[DEFAULT_MODEL].id);
    } catch (err) {
      const why = err?.status === 401
        ? "Make sure you copied the whole key."
        : err?.message ?? String(err);
      return json(res, 400, { error: "That key didn't work. " + why });
    }
    config.apiKey = key.trim();
    client = null;
    writeJson(configFile, config);
    checkBrains().catch(() => {});
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

  // ---- Recents: every call (from each friend's call log) plus missed or declined calls (their voicemails) ----
  // Clearing only hides calls from this list: call logs, memory and voicemail are all kept. Shows the last 30.
  if (req.method === "POST" && url.pathname === "/api/recents/clear") {
    const { which } = await readBody(req);
    if (!["all", "incoming", "outgoing"].includes(which)) return json(res, 400, { error: "Clear all, incoming or outgoing." });
    const r = readJson(recentsFile, {});
    const now = new Date().toISOString();
    r.cleared = { ...(r.cleared ?? {}) };
    if (which !== "outgoing") r.cleared.incoming = now;
    if (which !== "incoming") r.cleared.outgoing = now;
    writeJson(recentsFile, r);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/recents") {
    const cleared = readJson(recentsFile, {}).cleared ?? {};
    const items = [];
    for (const c of listContacts()) {
      const face = c.settings.face && faceFile(c.settings.face) ? c.settings.face : null;
      const who = { contact: c.id, name: c.name, face, active: c.active !== false };
      for (const e of callLogEntries(c.id)) items.push({ ...who, kind: e.incoming ? "incoming" : "outgoing", when: e.when, at: e.at });
      for (const v of readVoicemails(c.id)) {
        items.push({ ...who, kind: v.declined ? "declined" : "missed", when: v.when, at: v.at, voicemail: v.deleted ? null : v.id, heard: v.heard || !!v.deleted });
      }
    }
    const shown = items.filter((r) => {
      const since = cleared[r.kind === "outgoing" ? "outgoing" : "incoming"]; // missed and declined calls came in
      return !since || r.at > since;
    });
    return json(res, 200, shown.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30));
  }

  // ---- Voicemail ----
  if (req.method === "POST" && url.pathname === "/api/voicemail") {
    const { contact, declined } = await readBody(req);
    const c = loadContact(contact);
    if (!c) return json(res, 400, { error: "No such friend." });
    // Count the missed call (worried friends call back sooner); it clears after your next real call with them.
    c.memory.missed = {
      count: (c.memory.missed?.count ?? 0) + 1, at: new Date().toISOString(), atOpenMinute: config.openMinutes ?? 0,
      last: new Date().toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" }),
    };
    writeJson(contactPath(c.id, "memory.json"), c.memory);
    if (config.airplane) return json(res, 400, { error: "Airplane mode is on. Turn it off in Settings → Account to call." });
    if (!getClient()) return json(res, 400, { error: "No API key yet." });
    try {
      return json(res, 200, await leaveVoicemail(c, declined));
    } catch (err) {
      console.error("Voicemail failed:", err?.message ?? err);
      return json(res, 502, { error: err?.message ?? String(err) });
    }
  }
  // ---- Texts ----
  if (req.method === "GET" && url.pathname === "/api/texts/threads") {
    return json(res, 200, [...supportThread(), ...listContacts().map((c) => {
      const list = shownTexts(c.id);
      const last = list.at(-1);
      return last && {
        contact: c.id, name: c.name, face: c.settings.face && faceFile(c.settings.face) ? c.settings.face : null, active: c.active !== false,
        last: last.video ? "🎬 Video" : last.photo ? "📷 Photo" : last.gif ? "GIF" : last.text, lastFrom: last.from, at: last.at, unread: list.filter((t) => t.from === "them" && !t.read).length,
      };
    }).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))]);
  }
  if (req.method === "GET" && url.pathname === "/api/texts") {
    const c = loadContact(url.searchParams.get("contact"));
    if (!c) return json(res, 404, { error: "No such friend." });
    return json(res, 200, shownTexts(c.id).slice(-200));
  }
  const photoReq = url.pathname.match(/^\/api\/photos\/([a-z0-9-]+)\/([^/]+)$/);
  if (req.method === "GET" && photoReq) {
    const file = decodeURIComponent(photoReq[2]);
    const name = file.replace(/^(made|videos|spicy)\//, "");
    if (!validId(photoReq[1]) || !name || path.basename(name) !== name || !(PHOTO_EXT.test(name) || /\.mp4$/i.test(name))) return json(res, 400, { error: "Bad photo." });
    const full = path.join(photoDir(photoReq[1]), file);
    if (!fs.existsSync(full)) return json(res, 404, { error: "That photo is gone." });
    res.writeHead(200, { "Content-Type": /\.mp4$/i.test(file) ? "video/mp4" : photoMime(file), "Cache-Control": "max-age=86400" });
    return fs.createReadStream(full).pipe(res);
  }
  const albumReq = url.pathname.match(/^\/api\/album\/([a-z0-9-]+)$/);
  if (req.method === "POST" && albumReq) {
    const c = loadContact(albumReq[1]);
    if (!c) return json(res, 400, { error: "No such friend." });
    fs.mkdirSync(photoDir(c.id), { recursive: true });
    spawn("explorer", [photoDir(c.id)], { detached: true, stdio: "ignore" }).unref();
    syncAlbum(c).catch(() => {});
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/texts/hide") {
    const { contact } = await readBody(req);
    const c = loadContact(contact);
    if (!c) return json(res, 404, { error: "No such friend." });
    const list = readTexts(c.id);
    for (const t of list) {
      t.hidden = true;
      t.read = true;
    }
    writeTexts(c.id, list);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/texts/read") {
    const { contact } = await readBody(req);
    const c = loadContact(contact);
    if (!c) return json(res, 404, { error: "No such friend." });
    const list = readTexts(c.id);
    for (const t of list) if (t.from === "them") t.read = true;
    writeTexts(c.id, list);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && (url.pathname === "/api/texts/send" || url.pathname === "/api/texts/start")) {
    const { contact, text, gif, gifs } = await readBody(req);
    const c = loadContact(contact);
    if (!c) return json(res, 400, { error: "No such friend." });
    if (config.airplane) return json(res, 400, { error: "Airplane mode is on." });
    // GIFs you stacked up before pressing send (up to 6), each described so the friend knows what it shows.
    const sentGifs = (Array.isArray(gifs) ? gifs : gif ? [gif] : []).slice(0, 6)
      .filter((g) => g?.url && /^https:\/\/media\d*\.giphy\.com\//.test(g.url))
      .map((g) => ({ url: g.url, title: String(g.title ?? "GIF").slice(0, 100) }));
    if (sentGifs.length && !config.airplane) {
      await Promise.all(sentGifs.map(async (g) => {
        const desc = await describeGif(g);
        if (desc) g.desc = desc;
      }));
    }
    if (!getClient()) return json(res, 400, { error: "No API key yet." });
    const opener = url.pathname.endsWith("/start");
    // Friends text first only when they're free to, and not during your quiet hours.
    if (opener && (!canReachOut(scheduleOf(c), "text") || userBusy() === "quiet")) return json(res, 409, { error: `${firstName(c)} is busy.` });
    if (!opener) {
      const said = String(text ?? "").trim().slice(0, 2000);
      if (!said && !sentGifs.length) return json(res, 400, { error: "Nothing to send." });
      if (!c.support && /^\/ai\b/i.test(said)) {
        const ask = said.replace(/^\/ai\b[:\s]*/i, "").trim();
        if (!ask) return json(res, 400, { error: "Tell them what to do after /ai, like: /ai send a pic of you at lunch" });
        noteActivity();
        try { return json(res, 200, { ...(await aiDirect(c, ask)), direct: true }); } catch (err) { return json(res, 502, { error: err?.message ?? String(err) }); }
      }
      const at = new Date().toISOString(), stamp = Date.now();
      const mine = sentGifs.map((g, i) => ({ id: `${stamp}-${i}`, from: "me", text: "", gif: g, at, read: true }));
      if (said) mine.push({ id: `${stamp}`, from: "me", text: said, at, read: true });
      writeTexts(c.id, [...readTexts(c.id), ...mine]);
      noteActivity();
      if (c.support) {
        try { return json(res, 200, await supportText(c, said)); } catch (err) { return json(res, 502, { error: err?.message ?? String(err) }); }
      }
      // Their answer comes when they'd really get to it: seconds in a live back-and-forth, minutes or hours otherwise,
      // after work or in the morning if they're busy or asleep. The page picks it up from /api/updates.
      const lastThem = readTexts(c.id).findLast((t) => t.from === "them");
      const live = !!lastThem && Date.now() - Date.parse(lastThem.at) < 6 * 60 * 1000;
      const p = setPending(c, { kind: "reply", dueAt: Date.now() + replyDelayMs(scheduleOf(c), { live }), since: new Date().toISOString(), what: nowFor(c).what });
      return json(res, 200, { texts: [], waiting: true, dueIn: p.dueAt - Date.now(), now: nowLine(c) });
    }
    try {
      return json(res, 200, await friendTexts(c, { opener }));
    } catch (err) {
      console.error("Texting failed:", err?.message ?? err);
      return json(res, 502, { error: err?.message ?? String(err) });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/gifs") {
    try {
      return json(res, 200, await searchGifs(String(url.searchParams.get("q") ?? "").trim().slice(0, 60)));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/giphy-key") {
    // The GIPHY key is never deleted, not even by Reset phone; a new working key can only replace it.
    const key = String((await readBody(req)).key ?? "").trim();
    if (!key) return json(res, 400, { error: "Paste a GIPHY key first." });
    const before = config.giphyKey;
    config.giphyKey = key;
    try { await searchGifs("hello", 1); } catch (err) { config.giphyKey = before; return json(res, 400, { error: err.message }); }
    writeJson(configFile, config);
    return json(res, 200, { ok: true, hasKey: !!config.giphyKey });
  }
  if (req.method === "POST" && url.pathname === "/api/google-key") {
    // Like the GIPHY key: never deleted, not even by Reset phone; a new working key can only replace it.
    const key = String((await readBody(req)).key ?? "").trim();
    if (!key) return json(res, 400, { error: "Paste a Google AI key first." });
    try { await geminiCheckKey(key); } catch (err) { return json(res, 400, { error: err.message }); }
    config.googleKey = key;
    writeJson(configFile, config);
    checkBrains().catch(() => {});
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/xai-key") {
    // Like the Google key: never deleted, not even by Reset phone; a new working key can only replace it.
    const key = String((await readBody(req)).key ?? "").trim();
    if (!key) return json(res, 400, { error: "Paste an xAI key first." });
    const r = await fetch("https://api.x.ai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!r?.ok) return json(res, 400, { error: r && [400, 401, 403].includes(r.status) ? "xAI didn't accept the key." : `xAI answered ${r?.status ?? "nothing"}.` });
    config.xaiKey = key;
    writeJson(configFile, config);
    await checkBrains().catch(() => {});
    return json(res, 200, { ok: true, models: grokModels() });
  }
  if (req.method === "GET" && url.pathname === "/api/support") {
    return json(res, 200, listSupport().filter((c) => voiceFile(c.settings.cbVoice)).map((c) => ({ id: c.id, name: c.name })));
  }
  if (req.method === "GET" && url.pathname === "/api/notices") return json(res, 200, readJson(noticesFile, []));
  if (req.method === "POST" && url.pathname === "/api/notices/clear") {
    const { ids } = await readBody(req);
    const drop = new Set(Array.isArray(ids) ? ids : []);
    writeJson(noticesFile, readJson(noticesFile, []).filter((n) => !drop.has(n.id)));
    return json(res, 200, { ok: true });
  }
  // Call waiting: put the current call on hold to answer another friend, then go back to them.
  if (req.method === "POST" && url.pathname === "/api/call/hold") {
    if (!call) return json(res, 400, { error: "Not in a call." });
    if (held) return json(res, 400, { error: "Both lines are busy." });
    held = call;
    call = null;
    return json(res, 200, { held: held.contactId });
  }
  if (req.method === "POST" && url.pathname === "/api/call/resume") {
    if (!held) return json(res, 400, { error: "No one is on hold." });
    if (call) await hangUp();
    call = held;
    held = null;
    call.messages.push({ role: "user", content: "(Your buddy is back on the line after putting you on hold to take another call.)" });
    return streamReply(res);
  }
  if (req.method === "GET" && url.pathname === "/api/voicemail") {
    const all = listContacts().flatMap((c) => keptVoicemails(c.id).map((v) => ({
      ...v, contact: c.id, name: c.name, face: c.settings.face && faceFile(c.settings.face) ? c.settings.face : null,
    })));
    return json(res, 200, all.sort((a, b) => b.at.localeCompare(a.at)));
  }
  if (req.method === "GET" && url.pathname === "/api/voicemail/audio") {
    const id = String(url.searchParams.get("id") || "");
    const contact = url.searchParams.get("contact");
    if (!validId(contact) || !/^[\w-]+$/.test(id)) return json(res, 400, { error: "Bad voicemail." });
    const file = path.join(voicemailDir(contact), `${id}.wav`);
    if (!fs.existsSync(file)) return json(res, 404, { error: "No such voicemail." });
    res.writeHead(200, { "Content-Type": "audio/wav" });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === "POST" && url.pathname === "/api/voicemail/delete") {
    const { contact, id } = await readBody(req);
    if (!validId(contact) || !/^[\w-]+$/.test(String(id ?? ""))) return json(res, 400, { error: "Bad voicemail." });
    const list = readVoicemails(contact);
    const v = list.find((x) => x.id === id);
    if (!v) return json(res, 404, { error: "No such voicemail." });
    // Deleting removes the audio and hides it from your voicemail list; the words stay in index.json so your friend
    // remembers what they said, and so it can still teach them about you.
    fs.rmSync(path.join(voicemailDir(contact), `${id}.wav`), { force: true });
    v.deleted = true;
    v.heard = true;
    writeVoicemails(contact, list);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/voicemail/heard") {
    const { contact, id } = await readBody(req);
    if (!validId(contact)) return json(res, 400, { error: "Bad voicemail." });
    const list = readVoicemails(contact);
    const v = list.find((x) => x.id === id);
    if (v && !v.heard) {
      v.heard = true;
      writeVoicemails(contact, list);
    }
    return json(res, 200, { ok: true });
  }

  // ---- Contacts ----
  if (req.method === "GET" && url.pathname === "/api/contacts") {
    return json(res, 200, listContacts().map((c) => ({
      id: c.id, name: c.name, face: c.settings.face && faceFile(c.settings.face) ? c.settings.face : null,
      hasVoice: !!voiceFile(c.settings.cbVoice), callsYou: callsYouOf(c), callOdds: CALL_FREQ[callsYouOf(c)].odds * activityFactor(),
      now: (({ what, calls, texts }) => ({ what, calls, texts }))(nowFor(c)), nowLine: nowLine(c),
      newVoicemail: keptVoicemails(c.id).filter((v) => !v.heard).length, role: shownRole(c.role ?? "friend"),
      roleChoices: roleChoicesFor(friendGender(c), c.role ?? "friend", hasTalked(c)), ready: identityReady(c),
      worry: c.worry ?? catalogEntry(c.id)?.worry ?? "normal", textsYou: textsYouOf(c), textScale: TEXT_FREQ[textsYouOf(c)].scale, textsPerDay: textsPerDay(c) * activityFactor(),
      // openMinutes: how long the app has been open since their last missed call (time closed doesn't count).
      missed: c.memory.missed ? { ...c.memory.missed, openMinutes: (config.openMinutes ?? 0) - (c.memory.missed.atOpenMinute ?? config.openMinutes ?? 0) } : null,
      active: c.active !== false, calls: c.memory.calls, lastCall: c.memory.lastCall,
    })));
  }
  const contactRoute = url.pathname.match(/^\/api\/contacts\/([a-z0-9-]+)$/);
  if (contactRoute) {
    const c = loadContact(contactRoute[1]);
    if (!c) return json(res, 404, { error: "No such friend." });
    if (req.method === "POST" && url.searchParams.get("do") === "prepare") {
      if (identityReady(c)) return json(res, 200, { ready: true, built: false });
      if (!getClient()) return json(res, 400, { error: "No API key yet." });
      if (url.searchParams.get("wait") !== "1") { refreshIdentity(c); return json(res, 200, { ready: false, building: true }); }
      try {
        await buildIdentity(c);
        return json(res, 200, { ready: true, built: true });
      } catch (err) {
        console.error("Building identity failed:", err?.message ?? err);
        return json(res, 200, { ready: false, error: err?.message }); // the call still works, from the raw persona
      }
    }
    if (req.method === "GET" && url.searchParams.get("do") === "learned") {
      const texts = readTexts(c.id).filter((t) => !t.remembered).length;
      return json(res, 200, {
        notes: c.memory.notes ?? "", rules: c.memory.rules ?? "", calls: c.memory.calls ?? 0, lastCall: c.memory.lastCall ?? null,
        heard: (c.links ?? []).map((l) => {
          let h = "";
          try { h = fs.readFileSync(heardFromPath(c.id, l.id), "utf8").trim(); } catch {}
          return h && { from: loadContact(l.id)?.name ?? l.id, notes: h };
        }).filter(Boolean),
        pendingTexts: texts,
      });
    }
    if (req.method === "DELETE") {
      const { confirm } = await readBody(req);
      if (String(confirm ?? "").trim().toLowerCase() !== firstName(c).toLowerCase()) {
        return json(res, 400, { error: `Type ${firstName(c)} to confirm.` });
      }
      uninstallFriend(c);
      return json(res, 200, { ok: true });
    }
    if (req.method === "PUT") {
      const { settings = {}, active, role, cussing, flirting, speaks, spicyMedia } = await readBody(req);
      if (typeof spicyMedia === "boolean") c.spicyMedia = spicyMedia || undefined;
      if (speaks === "" || LANGS[speaks]) c.speaks = speaks || undefined;
      if (FLIRTING.includes(flirting)) c.flirting = flirting;
      const bad = (k) => (k === "callsYou" && !CALL_FREQ[settings[k]]) || (k === "textsYou" && !TEXT_FREQ[settings[k]]);
      const voiceBefore = c.settings.cbVoice;
      for (const k of SETTING_KEYS) if (k in settings && !bad(k)) c.settings[k] = settings[k];
      if (c.settings.cbVoice !== voiceBefore) setTimeout(() => ensureGreeting(loadContact(c.id)), 0);
      if (cussing === true) c.cussing = true;
      if (cussing === false) delete c.cussing;
      if (role !== undefined && role !== shownRole(c.role ?? "friend")) {
        if (!roleChoicesFor(friendGender(c), c.role ?? "friend", hasTalked(c)).includes(role)) {
          return json(res, 400, { error: `${c.name} can't become your ${String(role).replace("-", " ")}. Once you've talked, family stays family, and friends can only move between kinds of friends.` });
        }
        c.role = resolveRole(role, friendGender(c));
      }
      // Turned-off friends are hidden, never call you and hear no news. Turned back on, they catch up on the news.
      let caughtUpSince = null;
      if (active === false && c.active !== false) c.inactiveSince = new Date().toISOString();
      if (active === true && c.inactiveSince) {
        caughtUpSince = c.inactiveSince;
        delete c.inactiveSince;
      }
      if (typeof active === "boolean") c.active = active;
      if (caughtUpSince && getClient()) setTimeout(() => catchUp(loadContact(c.id), caughtUpSince).catch((err) => console.error("Catch-up failed:", err?.message ?? err)), 0);
      else if (caughtUpSince) c.catchUpSince = caughtUpSince; // in airplane mode: catch up when it's turned off
      if (c.settings.model && !MODELS[c.settings.model]) c.settings.model = DEFAULT_MODEL;
      if (Object.keys(settings).length) delete c.legacy;
      saveContact(c);
    }
    return json(res, 200, {
      id: c.id, name: c.name, firstName: firstName(c), settings: c.settings, legacy: !!c.legacy, role: shownRole(c.role ?? "friend"),
      active: c.active !== false, calls: c.memory.calls, lastCall: c.memory.lastCall, cussing: !!c.cussing, flirting: flirtingOf(c), speaks: LANGS[c.speaks] ? c.speaks : "",
    });
  }

  // Does the friend pick up? Asleep or at work, it rings out (or they decline) and they text about it later.
  if (req.method === "POST" && url.pathname === "/api/call/try") {
    const { contact: contactId } = await readBody(req);
    const c = loadContact(contactId);
    if (!c) return json(res, 400, { error: "No such friend." });
    noteActivity();
    if (c.support || answersCall(scheduleOf(c))) return json(res, 200, { answers: true });
    const st = nowFor(c);
    const declined = st.texts !== "none" && Math.random() < 0.5;
    const dueAt = declined
      ? Date.now() + (1 + Math.random() * 3) * 60 * 1000
      : (st.until?.getTime() ?? Date.now() + 60 * 60 * 1000) + (5 + Math.random() * 40) * 60 * 1000;
    setPending(c, {
      kind: "followup", dueAt, since: new Date().toISOString(), what: st.what,
      about: declined
        ? `you just declined your buddy's call because you're ${st.what}; text that you can't talk right now and when you can`
        : `you missed your buddy's call earlier because you were ${st.what}; text them about it (sorry I missed you, what's up?)`,
    });
    return json(res, 200, { answers: false, declined, what: st.what });
  }
  if (req.method === "GET" && url.pathname === "/api/voicemail/greeting") {
    const c = loadContact(url.searchParams.get("contact"));
    if (!c) return json(res, 404, { error: "No such friend." });
    const g = await voicemailGreeting(c).catch(() => ({ text: `Hi, you've reached ${firstName(c)}. Leave a message.`, file: null }));
    if (!g.file) return json(res, 200, { text: g.text });
    res.writeHead(200, { "Content-Type": "audio/wav", "X-Greeting": encodeURIComponent(g.text) });
    return fs.createReadStream(g.file).pipe(res);
  }
  if (req.method === "POST" && url.pathname === "/api/voicemail/leave") {
    const { contact: id, text } = await readBody(req);
    const c = loadContact(id);
    if (!c) return json(res, 404, { error: "No such friend." });
    const said = String(text ?? "").trim().slice(0, 3000);
    if (!said) return json(res, 200, { ok: true, empty: true });
    writeTexts(c.id, [...readTexts(c.id), { id: `${Date.now()}`, from: "me", text: said, vm: true, hidden: true, at: new Date().toISOString(), read: true }]);
    const st = nowFor(c);
    const cur = readPending(c.id);
    const dueAt = cur?.dueAt ?? (st.texts === "none" ? (st.until?.getTime() ?? Date.now() + 3600e3) + 20 * 60e3 : Date.now() + (5 + Math.random() * 40) * 60e3);
    setPending(c, {
      kind: "followup", dueAt, since: new Date().toISOString(), what: st.what,
      about: `your buddy called while you were ${st.what === "free" ? "away from your phone" : st.what}, and left you a voicemail: "${said}". You just listened to it. Answer it the way you would: text back about what they said, or say you'll call them`,
    });
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/updates") {
    const after = Number(url.searchParams.get("after") ?? 0);
    const typing = listContacts().filter((c) => delivering.has(c.id) || ((p) => p && p.dueAt - Date.now() < 12000)(readPending(c.id))).map((c) => c.id);
    return json(res, 200, { seq: updateSeq, events: updates.filter((u) => u.seq > after), typing });
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    if (config.airplane) return json(res, 400, { error: "Airplane mode is on. Turn it off in Settings → Account to call." });
    if (!getClient()) return json(res, 400, { error: "No API key yet." });
    const { contact: contactId, incoming } = await readBody(req);
    const c = loadContact(contactId);
    if (!c) return json(res, 400, { error: "No such friend." });
    warmLanguages(c).catch(() => {});
    if (call) await hangUp();
    call = {
      contactId: c.id,
      incoming: !!incoming,
      started: new Date(),
      system: `${await systemPrompt(c)}${c.support ? "" : `\n\n${TEXTING_DURING_CALL}`}`,
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
    const { text, interrupted } = await readBody(req);
    if (!call) return json(res, 400, { error: "Not in a call." });
    const said = String(text || "").slice(0, 4000);
    // Game news that happened since your last words (from the game watcher), so they can react right away.
    const news = call.gameNews?.length ? `(Just now, you see on your TV: ${call.gameNews.join("; then ")}.) ` : "";
    call.gameNews = [];
    call.messages.push({
      role: "user",
      // They talked over the friend, who stopped mid-sentence, so the rest of the friend's last reply went unheard.
      content: news + (interrupted ? `(Your buddy cut in while you were still talking, so they didn't hear the rest of what you were saying.) ${said}` : said),
    });
    return streamReply(res);
  }

  if (req.method === "POST" && url.pathname === "/api/hangup") {
    await hangUp();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end();
});

// Football fans text about their team's game while the app is open: kickoff, their team scoring (and sometimes the
// other team), and the final. At most one text per friend every 10 minutes, apart from the final. Never after 11 PM.
// On a call with that friend, there is no text: the news goes into the call, so they react to it with your next words.
const games = new Map(); // team -> last seen { id, state, usScore, themScore }
const lastGameText = new Map(); // friend id -> time
setInterval(async () => {
  if (Date.now() - lastPing > 90 * 1000 || !getClient() || config.airplane) return;
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 8) return;
  const fans = listContacts().filter((c) => c.active !== false && c.knows?.nflTeam && (c.settings.textsYou ?? "sometimes") !== "never");
  for (const team of new Set(fans.map((c) => c.knows.nflTeam))) {
    let g;
    try { g = await knowledge.liveGame(team); } catch { continue; }
    if (!g) continue;
    const before = games.get(team);
    games.set(team, g);
    if (!before || before.id !== g.id) continue; // first look at this game: just remember it
    let about = null, final = false;
    if (before.state === "pre" && g.state === "in") about = `the ${g.us} game against the ${g.them} is kicking off`;
    else if (g.state === "in" && g.usScore > before.usScore) about = `the ${g.us} just scored (${g.us} ${g.usScore}, ${g.them} ${g.themScore}, ${g.detail})`;
    else if (g.state === "in" && g.themScore - before.themScore >= 7 && Math.random() < 0.5) about = `the ${g.them} just scored on the ${g.us} (${g.us} ${g.usScore}, ${g.them} ${g.themScore}, ${g.detail})`;
    else if (before.state === "in" && g.state === "post") { about = `the ${g.us} game just ended: ${g.us} ${g.usScore}, ${g.them} ${g.themScore}`; final = true; }
    if (!about) continue;
    for (const c of fans.filter((f) => f.knows.nflTeam === team)) {
      // On a call with them (or on hold): no text; they hear it live with whatever you say next.
      const live = [call, held].find((x) => x?.contactId === c.id);
      if (live) { (live.gameNews ??= []).push(about); continue; }
      if (!final && Date.now() - (lastGameText.get(c.id) ?? 0) < 10 * 60 * 1000) continue;
      lastGameText.set(c.id, Date.now());
      friendTexts(c, { opener: true, about }).catch((err) => console.error("Game text failed:", err?.message ?? err));
    }
  }
}, 60 * 1000); // ESPN is free; once a minute keeps reactions close to live

// Time only counts while the app is open: config.openMinutes goes up once a minute while the page is talking to us.
// Worried friends' call-back clocks run on it, so closing the app pauses them (see the scheduler in index.html).
setInterval(() => {
  if (Date.now() - lastPing > 90 * 1000) return;
  config.openMinutes = (config.openMinutes ?? 0) + 1;
  if (config.openMinutes % 5 === 0) writeJson(configFile, config);
}, 60 * 1000);

// Shut down once the call window has been closed for a while, saving any open call (and one on hold) first.
setInterval(async () => {
  if (Date.now() - lastPing > IDLE_SHUTDOWN_MS) {
    writeJson(configFile, config);
    await hangUp();
    if (held) { call = held; held = null; await hangUp(); }
    process.exit(0);
  }
}, 30 * 1000);

server.listen(PORT, "127.0.0.1", () => console.log(`Joe's picking up at http://localhost:${PORT}`));
