// Call Joe server: serves the call page, keeps each friend's persona and memory, and talks to Claude.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
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
// textsYou: how often this friend texts you on their own ("never", "sometimes" (their usual), "often").
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
function getClient() {
  if (!config.apiKey || config.airplane) return null;
  client ??= new Anthropic({ apiKey: config.apiKey });
  return client;
}

const chatModel = (c) => MODELS[c?.settings.model] ?? MODELS[DEFAULT_MODEL];

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
    read(supportNotesFile) && `# Notes from earlier support calls\n${read(supportNotesFile)}`,
    ENDING_THE_CALL,
    `# Right now\nIt's ${now}. Airplane mode is ${config.airplane ? "on" : "off"}.`,
  ].filter(Boolean).join("\n\n");
}

// Settings support agents can change by voice.
const SUPPORT_TOOLS = [{
  name: "change_setting",
  description: "Change a setting for the caller, after they agree. friend settings: callsYou (never, sometimes, daily, often), textsYou (never, sometimes, often), active (true or false), role (a relationship like best-friend, close-friend, friend, distant-friend). Phone settings: airplane (true or false).",
  input_schema: {
    type: "object",
    properties: {
      friend: { type: "string", description: "The friend's first name, or empty for a phone setting." },
      setting: { type: "string", enum: ["callsYou", "textsYou", "active", "role", "airplane"] },
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
  const c = listContacts().find((f) => firstName(f).toLowerCase() === String(friend ?? "").trim().toLowerCase().split(" ")[0]);
  if (!c) return `There's no friend called ${friend}.`;
  if (setting === "callsYou" && CALLS_YOU.includes(value)) c.settings.callsYou = value;
  else if (setting === "textsYou" && ["never", "sometimes", "often"].includes(value)) c.settings.textsYou = value;
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

async function systemPrompt(c) {
  if (c.support) return supportPrompt(c);
  // Official friends use their merged identity; until then, the persona and relationship as written.
  const src = identitySource(c);
  const persona = identityReady(c) ? `${fs.readFileSync(identityFile(c.id), "utf8").trim()}\n\n${src.rules}` : null;
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
    missedCalls(c),
    ENDING_THE_CALL,
    knowledge.tools(c).length ? LOOKING_THINGS_UP : "",
    `# Memory\n${mem}${connectionNews(c)}${voicemailsLeft(c)}${recentTexts(c)}`,
    await knowledge.briefing(c, config.user?.home),
    `# Right now\nIt's ${now} where you both live. ${last}`,
  ].filter(Boolean).join("\n\n");
}

// ---- Text messages ----
// data/contacts/<id>/texts.json: [{ id, from: "me" | "them", text, at, read, remembered }]. Friends text back short,
// the way people really text. A long back-and-forth turns into a phone call (they text that they're calling and ring
// you), at a point set by who they are to you and their personality, which also keeps API use down. Texts reach the
// memory notes with the next call, or on their own once 20 pile up.
const textsFile = (id) => contactPath(id, "texts.json");
const readTexts = (id) => readJson(textsFile(id), []);
const writeTexts = (id, list) => writeJson(textsFile(id), list.slice(-500));
const CALL_MARK = "<call>";
// How many of your texts in one conversation before they'd rather call. Moms, grandparents and neighbors call sooner;
// best friends and siblings will text for ages. friend.json "texting": "calls" (prefers calling) cuts it, "texts" stretches it.
const TEXTS_BEFORE_CALL = {
  mom: 4, dad: 5, grandparent: 3, spouse: 8, sister: 8, brother: 8, "best-friend": 10, "girlfriend-bestie": 12,
  "close-friend": 8, cousin: 8, aunt: 5, uncle: 5, friend: 6, "family-friend": 5, neighbor: 4, coworker: 4,
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

// Builds the conversation for the model from recent texts (alternating turns, starting and ending with the buddy).
function textTurns(list, extra) {
  const turns = [];
  for (const t of list.slice(-40)) {
    const role = t.from === "me" ? "user" : "assistant";
    const line = t.gif ? (t.from === "me" ? `(sends a GIF: "${t.gif.title}")` : `[gif: ${t.gif.title}]`) : t.text;
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
};
function textHabit(c) {
  const own = c.textHabits ?? catalogEntry(c.id)?.textHabits ?? [];
  const pool = [...(TEXT_HABITS[c.role] ?? TEXT_HABITS.friend), ...own, ...own]; // their own habits come up more
  return pool[Math.floor(Math.random() * pool.length)];
}
const textsPerDay = (c) => (TEXTS_PER_DAY[c.role] ?? 0.7) * (c.textScale ?? catalogEntry(c.id)?.textScale ?? 1);

// Asks the friend for their next text(s). opener: they're texting first; about: what prompted it.
async function friendTexts(c, { opener = false, about = null } = {}) {
  const list = readTexts(c.id);
  const thread = currentThread(list);
  const mine = thread.filter((t) => t.from === "me").length;
  const wantsCall = !opener && mine >= textsBeforeCall(c);
  const note = opener
    ? `(You decide to text your buddy, on your own. What prompted it: ${about ?? textHabit(c)}. Text the way you would. Just the text.)`
    : wantsCall
      ? `(This text conversation has gone on a while, and you'd rather just talk. Text that you're calling, in your own style, and end with ${CALL_MARK}.)`
      : null;
  const model = chatModel(c);
  const msg = await getClient().beta.messages.create({
    model: model.id,
    max_tokens: 1500,
    output_config: { effort: "low" },
    ...model.params,
    system: `${await systemPrompt(c)}\n\n${TEXTING}`,
    messages: textTurns(list, note),
  });
  if (msg.stop_reason === "refusal") throw new Error("They couldn't text back right now.");
  let raw = textOf(msg.content).replaceAll(HANGUP, "");
  const call = raw.includes(CALL_MARK);
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
  if (readTexts(c.id).filter((t) => !t.remembered).length >= 20) rememberTexts(c).catch(() => {});
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
  return fresh.map((t) => `[text ${textWhen(t.at)}] ${t.from === "me" ? "Buddy" : first}: ${t.gif ? `(GIF: ${t.gif.title})` : t.text}`).join("\n");
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
  return `\n\n# Recent texts with your buddy\n` + recent.map((t) => `- ${textWhen(t.at)}, ${t.from === "me" ? "buddy" : first}: ${t.text}`).join("\n");
}

// ---- Voicemail ----
// When a friend rings and you miss or decline, they leave a voicemail: written in character (with their memory and
// briefing), spoken in their cloned voice, and saved in data/contacts/<id>/voicemail/ with an index.json. They
// remember the last few they left, and whether you've listened.
const voicemailDir = (id) => path.join(contactsDir, id, "voicemail");
const readVoicemails = (id) => readJson(path.join(voicemailDir(id), "index.json"), []);
const writeVoicemails = (id, list) => writeJson(path.join(voicemailDir(id), "index.json"), list);

function voicemailsLeft(c) {
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = readVoicemails(c.id).filter((v) => Date.parse(v.at) > week).slice(-3);
  if (!recent.length) return "";
  return `\n\n# Voicemails you left your buddy\n` + recent.map((v) =>
    `- ${v.when} (${v.heard ? "they've listened to it" : "they haven't listened yet"}): "${v.text}"`).join("\n");
}

async function leaveVoicemail(c, declined) {
  const model = chatModel(c);
  const msg = await getClient().beta.messages.create({
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
  const text = textOf(msg.content).replaceAll(HANGUP, "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("The voicemail came out empty.");

  const file = voiceFile(c.settings.cbVoice);
  if (!file) throw new Error(`${c.name} needs a voice clip to leave a voicemail.`);
  await chatterbox.start();
  const r = await fetch(`${chatterbox.url}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 1000), voice_path: file }),
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

const ENDING_THE_CALL = `# Ending the call
You can hang up, like on a real phone. When the call is clearly over, because you've both said goodbye, or your buddy said they have to go and you've said bye back, finish your goodbye and put ${HANGUP} at the very end of that last message. It's a signal, not something you say.
Don't hang up during a pause, in the middle of a conversation, or while your buddy is upset or struggling. If you're not sure the call is over, don't hang up. Keep talking or ask if they need to go.`;

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
  ["spouse", "Spouse"],
];
// Relationships that make sense. Family by blood or marriage has a gender (a man can't be your sister) and, once you've
// talked or texted, is fixed for good: your sister can't later become your wife or your coworker. Friendships can grow
// closer or drift (best friend <-> close friend <-> friend <-> distant friend), and anyone in the friends group can be
// moved anywhere in it. Before the first call or text, anything that fits their gender is fine.
const ROLE_GENDER = { mom: "woman", sister: "woman", aunt: "woman", dad: "man", brother: "man", uncle: "man" };
const FRIEND_ROLES = new Set(["best-friend", "close-friend", "friend", "distant-friend", "family-friend", "neighbor", "coworker"]);
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
      hasFace: fs.existsSync(path.join(personasDir, id, "face.png")),
      role: shownRole(resolveRole(f.roles?.[yourGender()] ?? "friend", f.gender)), roleChoices: roleChoicesFor(f.gender, null, false),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function installFriend(id, role) {
  const f = catalogEntry(id);
  if (!f) throw new Error("That friend can't be installed.");
  if (loadContact(id)) throw new Error(`${f.name} is already installed.`);
  role = ROLE_CHOICES.some(([r]) => r === role) ? role : f.roles?.[yourGender()] ?? "friend";
  const folder = path.join(personasDir, id);
  const settings = { model: MODELS[f.model] ? f.model : DEFAULT_MODEL, cbVoice: `${f.name} voice` };
  if (["sometimes", "often"].includes(f.callsYou)) settings.callsYou = f.callsYou; // like Coop, who's clingy
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
    role: resolveRole(role, f.gender), ...(f.support ? { support: true } : {}), ...(f.worry ? { worry: f.worry } : {}), ...(f.knows ? { knows: f.knows } : {}), ...(links.length ? { links } : {}),
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
  const { apiKey, airplane } = config;
  call = null;
  client = null;
  for (const name of fs.readdirSync(dataDir)) {
    if (name.endsWith(".log") || name === "cache") continue;
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
  fs.mkdirSync(contactsDir, { recursive: true });
  setTimeout(installSupport, 0);
  config = { setupDone: false, ...(apiKey ? { apiKey } : {}), ...(airplane ? { airplane } : {}) };
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
  try {
    const c = loadContact(call.contactId);
    const model = chatModel(c);
    const tools = c.support ? SUPPORT_TOOLS : knowledge.tools(c);
    for (let round = 0; round < 6; round++) {
      const stream = getClient().beta.messages.stream({
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
    res.write(held);
    if (hangingUp) res.write("\u0000HANGUP");
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
    const said = ended.messages.slice(1).map((m) => `${m.role === "user" ? "Caller" : firstName(c)}: ${textOf(m.content).replaceAll(HANGUP, "").trim()}`).join("\n");
    fs.appendFileSync(path.join(dataDir, "support-calls.txt"), `\n===== Support call with ${firstName(c)}, ${ended.started.toLocaleString("en-US")} =====\n${said}\n`);
    if (said.trim()) await afterSupportCall(said);
    return;
  }
  const first = firstName(c);
  const memory = c.memory;
  const memoryFile = contactPath(c.id, "memory.json");
  let transcript = ended.messages
    .slice(1)
    .map((m) => `${m.role === "user" ? "Buddy" : first}: ${textOf(m.content).replaceAll(HANGUP, "").trim()}`)
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
const CALLS_YOU = ["never", "sometimes", "daily", "often"];
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
        `Also decide whether the buddy changed how often ${first} may call them while the app is open: "never", "sometimes" (every few hours), "daily" (about once a day), or "often" (about every hour). "Call me anytime" means daily unless they clearly want more. Use null if nothing was said about it. ` +
        (sp ? `The buddy is married to ${sp.name}. Also merge everything the buddy said about ${sp.name} into the existing notes about them (likes, plans, health, gift ideas, how things are between them), as short '- ' lines, at most 30, and list any dates mentioned for ${sp.name} or the two of them (birthday, anniversary, a big event) as MM-DD. ` : "") +
        `Answer with JSON only: {"rules": "...", "callsYou": null or one of the values, "why": "a few words, when callsYou changes"${sp ? `, "spouseNotes": "...", "spouseDates": [{"what": "${sp.name}'s birthday", "date": "MM-DD"}]` : ""}, "buddyBirthday": null or "MM-DD" if the buddy said when their own birthday is}.`,
      messages: [{ role: "user", content: `Existing rules:\n${memory.rules || "(none yet)"}\n\n${sp ? `Existing notes about ${sp.name}:\n${sp.notes || "(none yet)"}\n\n` : ""}Newest call:\n${transcript}\n\n${first} is currently allowed to call: ${c.settings.callsYou ?? "never"}.` }],
    });
    if (msg.stop_reason === "refusal") return;
    const out = JSON.parse(textOf(msg.content).replace(/^```(json)?|```$/gm, "").trim());
    if (typeof out.rules === "string") memory.rules = out.rules.trim();
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
        const how = { never: "won't call you", sometimes: "will call now and then", daily: "will call about once a day", often: "will call often" }[out.callsYou];
        addNotice(`${first} ${how}${out.why ? ` (${out.why})` : ""}. Change it in their ✎ Edit.`, c.id);
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
      held: held?.contactId ?? null, hasGiphy: !!config.giphyKey, hasKey: !!config.apiKey, airplane: !!config.airplane, inCall: call?.contactId ?? null,
      setupDone: config.setupDone !== false, user: config.user ?? null,
    });
  }
  if (url.pathname === "/api/ping") return json(res, 200, { ok: true });

  // ---- You (first-time setup, or Settings -> You) ----
  if (req.method === "PUT" && url.pathname === "/api/profile") {
    saveProfileFrom(await readBody(req));
    return json(res, 200, config.user);
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
    const { id, role } = await readBody(req);
    try {
      const c = installFriend(id, role);
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
        items.push({ ...who, kind: v.declined ? "declined" : "missed", when: v.when, at: v.at, voicemail: v.id, heard: v.heard });
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
    return json(res, 200, listContacts().map((c) => {
      const list = readTexts(c.id);
      const last = list.at(-1);
      return last && {
        contact: c.id, name: c.name, face: c.settings.face && faceFile(c.settings.face) ? c.settings.face : null, active: c.active !== false,
        last: last.gif ? "GIF" : last.text, lastFrom: last.from, at: last.at, unread: list.filter((t) => t.from === "them" && !t.read).length,
      };
    }).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at)));
  }
  if (req.method === "GET" && url.pathname === "/api/texts") {
    const c = loadContact(url.searchParams.get("contact"));
    if (!c) return json(res, 404, { error: "No such friend." });
    return json(res, 200, readTexts(c.id).slice(-200));
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
    const { contact, text, gif } = await readBody(req);
    const c = loadContact(contact);
    if (!c) return json(res, 400, { error: "No such friend." });
    if (config.airplane) return json(res, 400, { error: "Airplane mode is on." });
    const sentGif = gif?.url && /^https:\/\/media\d*\.giphy\.com\//.test(gif.url) ? { url: gif.url, title: String(gif.title ?? "GIF").slice(0, 100) } : null;
    if (!getClient()) return json(res, 400, { error: "No API key yet." });
    const opener = url.pathname.endsWith("/start");
    if (!opener) {
      const said = String(text ?? "").trim().slice(0, 2000);
      if (!said && !sentGif) return json(res, 400, { error: "Nothing to send." });
      writeTexts(c.id, [...readTexts(c.id), { id: `${Date.now()}`, from: "me", text: said, ...(sentGif ? { gif: sentGif } : {}), at: new Date().toISOString(), read: true }]);
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
    const { key } = await readBody(req);
    config.giphyKey = String(key ?? "").trim() || undefined;
    if (config.giphyKey) {
      try { await searchGifs("hello", 1); } catch (err) { delete config.giphyKey; return json(res, 400, { error: err.message }); }
    }
    writeJson(configFile, config);
    return json(res, 200, { ok: true, hasKey: !!config.giphyKey });
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
    const all = listContacts().flatMap((c) => readVoicemails(c.id).map((v) => ({
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
      hasVoice: !!voiceFile(c.settings.cbVoice), callsYou: c.settings.callsYou ?? "never",
      newVoicemail: readVoicemails(c.id).filter((v) => !v.heard).length, role: shownRole(c.role ?? "friend"),
      roleChoices: roleChoicesFor(friendGender(c), c.role ?? "friend", hasTalked(c)), ready: identityReady(c),
      worry: c.worry ?? catalogEntry(c.id)?.worry ?? "normal", textsYou: c.settings.textsYou ?? "sometimes", textsPerDay: textsPerDay(c),
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
      const { settings = {}, active, role } = await readBody(req);
      for (const k of SETTING_KEYS) if (k in settings) c.settings[k] = settings[k];
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
      active: c.active !== false, calls: c.memory.calls, lastCall: c.memory.lastCall,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    if (config.airplane) return json(res, 400, { error: "Airplane mode is on. Turn it off in Settings → Account to call." });
    if (!getClient()) return json(res, 400, { error: "No API key yet." });
    const { contact: contactId, incoming } = await readBody(req);
    const c = loadContact(contactId);
    if (!c) return json(res, 400, { error: "No such friend." });
    if (call) await hangUp();
    call = {
      contactId: c.id,
      incoming: !!incoming,
      started: new Date(),
      system: await systemPrompt(c),
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
    call.messages.push({
      role: "user",
      // They talked over the friend, who stopped mid-sentence, so the rest of the friend's last reply went unheard.
      content: interrupted ? `(Your buddy cut in while you were still talking, so they didn't hear the rest of what you were saying.) ${said}` : said,
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
      if (!final && Date.now() - (lastGameText.get(c.id) ?? 0) < 10 * 60 * 1000) continue;
      lastGameText.set(c.id, Date.now());
      friendTexts(c, { opener: true, about }).catch((err) => console.error("Game text failed:", err?.message ?? err));
    }
  }
}, 2 * 60 * 1000);

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
