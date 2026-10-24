// When friends are free: each friend's day as time blocks (asleep, at work, lunch, practice...), what they can do in
// each (answer calls, text fast or slow), and how long a text reply takes. Pure functions; server.mjs keeps the data.
//
// A schedule (contact.json "schedule"):
// { "textStyle": "fast" | "normal" | "slow", "tz": "America/Chicago" (optional),
//   "blocks": [{ "what": "asleep", "days": "daily", "from": "22:30", "to": "06:00", "calls": "no", "texts": "none" }, ...] }
// days: "daily", "weekdays", "weekends", or names like "mon,wed,fri". calls: "yes" | "rare" | "no".
// texts: "fast" | "normal" | "slow" | "none". A later block wins where blocks overlap (lunch inside work).
// Outside every block a friend is free: calls "yes", texts "normal".

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FREE = { what: "free", calls: "yes", texts: "normal" };

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm ?? "").split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
};

// Day of week and minutes after midnight at that moment, in the friend's time zone (or this computer's).
function localClock(date, tz) {
  if (!tz) return { day: date.getDay(), minute: date.getHours() * 60 + date.getMinutes() };
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(date).map((p) => [p.type, p.value]));
    return { day: DAY_NAMES.indexOf(parts.weekday.toLowerCase().slice(0, 3)), minute: Number(parts.hour) * 60 + Number(parts.minute) };
  } catch {
    return { day: date.getDay(), minute: date.getHours() * 60 + date.getMinutes() };
  }
}

function onDay(days, day) {
  const d = String(days ?? "daily").toLowerCase();
  if (d === "daily" || d === "every day") return true;
  if (d === "weekdays") return day >= 1 && day <= 5;
  if (d === "weekends") return day === 0 || day === 6;
  return d.split(/[\s,]+/).some((x) => DAY_NAMES.indexOf(x.slice(0, 3)) === day);
}

// Is the block on at this moment? Blocks can run past midnight (asleep 22:30-06:00 belongs to the day it starts).
function blockOn(b, { day, minute }) {
  const from = toMinutes(b.from), to = toMinutes(b.to);
  if (from === null || to === null) return false;
  if (from <= to) return onDay(b.days, day) && minute >= from && minute < to;
  return (onDay(b.days, day) && minute >= from) || (onDay(b.days, (day + 6) % 7) && minute < to);
}

// What the friend is doing at a moment: the block (or free), and when it ends.
export function stateAt(schedule, date = new Date()) {
  const blocks = schedule?.blocks ?? [];
  const at = (d) => {
    const clock = localClock(d, schedule?.tz);
    let found = null;
    for (const b of blocks) if (blockOn(b, clock)) found = b;
    return found;
  };
  const block = at(date);
  const state = block ? { what: block.what, calls: block.calls ?? "yes", texts: block.texts ?? "normal" } : { ...FREE };
  // Walk forward along the clock's 5-minute marks (up to a day) to find when this changes.
  let until = null;
  const start = Math.ceil((date.getTime() + 1) / 300000) * 300000;
  for (let t = start; t <= date.getTime() + 864e5; t += 300000) {
    if (at(new Date(t)) !== block) { until = new Date(t); break; }
  }
  return { ...state, until };
}

// A friendly line for the prompt and Support: "at work (job site) until 3:30 PM".
export function describeState(state, tz) {
  if (state.what === "free") return "free";
  const time = state.until?.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) });
  return `${state.what}${time ? ` until ${time}` : ""}`;
}

// Random wait with a long tail: most are near the median, now and then much longer (log-normal).
function lognormal(median, spread = 0.9) {
  const u = 1 - Math.random(), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(spread * z);
}

const STYLE_MEDIAN_MIN = { fast: 1.5, normal: 5, slow: 25 }; // typical minutes before a reply, by texting style
const BLOCK_FACTOR = { fast: 0.4, normal: 1, slow: 5 };

// How long until the friend answers your text. live: you're in a quick back-and-forth with them right now.
// learned: a multiplier learned from how you reply (see server.mjs), 1 by default.
export function replyDelayMs(schedule, { now = new Date(), live = false, learned = 1 } = {}) {
  const state = stateAt(schedule, now);
  const style = schedule?.textStyle ?? "normal";
  if (state.texts === "none") {
    // Busy (asleep, in church): they answer a while after the block ends.
    const end = state.until?.getTime() ?? now.getTime() + 60 * 60 * 1000;
    return end - now.getTime() + lognormal(15, 0.8) * 60 * 1000;
  }
  if (live && state.texts !== "slow") return (8 + Math.random() * 35) * 1000; // they're on their phone with you
  const minutes = lognormal((STYLE_MEDIAN_MIN[style] ?? 5) * (BLOCK_FACTOR[state.texts] ?? 1) * learned);
  return Math.min(Math.max(minutes, 0.3), 6 * 60) * 60 * 1000;
}

// Would they pick up if you called right now? "rare" blocks answer now and then.
export function answersCall(schedule, now = new Date()) {
  const s = stateAt(schedule, now);
  return s.calls === "yes" || (s.calls === "rare" && Math.random() < 0.3);
}

// Can they reach out on their own right now (a call or a text)?
export function canReachOut(schedule, kind, now = new Date()) {
  const s = stateAt(schedule, now);
  if (kind === "call") return s.calls === "yes" || (s.calls === "rare" && Math.random() < 0.2);
  return s.texts !== "none";
}

// Checks a schedule from Claude or Support and keeps only valid parts.
export function cleanSchedule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const time = (t) => (/^\d{1,2}:\d{2}$/.test(String(t ?? "")) ? String(t).padStart(5, "0") : null);
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).map((b) => ({
    what: String(b?.what ?? "busy").slice(0, 120),
    days: String(b?.days ?? "daily").slice(0, 40),
    from: time(b?.from), to: time(b?.to),
    calls: ["yes", "rare", "no"].includes(b?.calls) ? b.calls : "yes",
    texts: ["fast", "normal", "slow", "none"].includes(b?.texts) ? b.texts : "normal",
  })).filter((b) => b.from && b.to).slice(0, 20);
  return {
    textStyle: ["fast", "normal", "slow"].includes(raw.textStyle) ? raw.textStyle : "normal",
    ...(typeof raw.tz === "string" && raw.tz ? { tz: raw.tz } : {}),
    blocks,
  };
}

// The schedule as a few readable lines, for Support and the Edit menu.
export function scheduleText(schedule) {
  if (!schedule?.blocks?.length) return "No schedule yet: free all day.";
  return [`Texting style: ${schedule.textStyle ?? "normal"}`, ...schedule.blocks.map((b) =>
    `${b.days} ${b.from}-${b.to}: ${b.what} (calls ${b.calls}, texts ${b.texts})`)].join("\n");
}
