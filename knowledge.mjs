// Live knowledge for friends: NFL data from ESPN's public site API, weather from Open-Meteo, and web search
// (Anthropic's server tool). Results are cached in data/cache/ until stale, and the feeds a friend follows are
// refreshed in the background while the app is open.
//
// A friend's contact.json can have:
//   "knows": { "nflTeam": "MIN", "home": "Minneapolis, Minnesota", "web": true }
// nflTeam  -> a Vikings (or any team) briefing at the start of each call, plus the sports lookup tool
// home     -> the weather where they live in the briefing, plus the weather lookup tool (any place)
// web      -> web search during calls (recipes, anything else)
import fs from "node:fs";
import path from "node:path";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/football/nfl/standings?level=3";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const WEATHER_CODES = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "foggy with frost",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "rain showers", 81: "rain showers",
  82: "heavy rain showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorms",
  96: "thunderstorms with hail", 99: "thunderstorms with hail",
};

export function createKnowledge(dataDir) {
  const cacheDir = path.join(dataDir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const memory = new Map(); // key -> { at, data }
  const inflight = new Map();

  const fileFor = (key) => path.join(cacheDir, `${key.replace(/[^\w.-]+/g, "_").slice(0, 120)}.json`);

  function read(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      const hit = JSON.parse(fs.readFileSync(fileFor(key), "utf8"));
      memory.set(key, hit);
      return hit;
    } catch {
      return null;
    }
  }

  // Returns cached data while it's fresh; otherwise loads it. If loading fails, stale data is better than none.
  async function cached(key, ttl, load) {
    const hit = read(key);
    if (hit && Date.now() - hit.at < ttl) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        const entry = { at: Date.now(), data: await load() };
        memory.set(key, entry);
        fs.writeFileSync(fileFor(key), JSON.stringify(entry));
        return entry;
      } catch (err) {
        if (hit) return hit;
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  async function getJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "CallJoe/1.0" } });
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return r.json();
  }

  const when = (iso) => new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });
  const ago = (at) => {
    const m = Math.round((Date.now() - at) / MIN);
    return m < 2 ? "just now" : m < 90 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`;
  };

  // ---------- NFL (ESPN) ----------
  const teams = () => cached("nfl-teams", 7 * 24 * HOUR, async () => {
    const j = await getJson(`${ESPN}/teams`);
    return j.sports[0].leagues[0].teams.map(({ team: t }) => ({
      abbr: t.abbreviation, name: t.displayName, short: t.shortDisplayName, location: t.location, nickname: t.name,
    }));
  });

  async function findTeam(q) {
    const want = String(q || "").trim().toLowerCase();
    const list = (await teams()).data;
    return list.find((t) => [t.abbr, t.name, t.short, t.nickname, t.location].some((x) => x?.toLowerCase() === want))
      ?? list.find((t) => t.name.toLowerCase().includes(want) || want.includes(t.nickname.toLowerCase()));
  }

  const gameLine = (e, abbr) => {
    const c = e.competitions[0];
    const status = c.status.type;
    const us = c.competitors.find((x) => x.team.abbreviation === abbr);
    const them = c.competitors.find((x) => x.team.abbreviation !== abbr);
    const score = (x) => (typeof x.score === "object" ? x.score?.displayValue : x.score) ?? "";
    const where = us?.homeAway === "home" ? "vs" : "at";
    if (status.completed) {
      const result = us?.winner ? "W" : them?.winner ? "L" : "T";
      return `${when(e.date)}: ${result} ${score(us)}-${score(them)} ${where} ${them?.team.displayName}`;
    }
    if (status.state === "in") return `LIVE NOW ${where} ${them?.team.displayName}: ${score(us)}-${score(them)} (${status.shortDetail})`;
    return `${when(e.date)} (Central): ${where} ${them?.team.displayName}`;
  };

  // Everything worth knowing about one team, as a few compact lines.
  async function teamReport(abbr) {
    // A game in progress needs fresher data than a quiet Tuesday.
    const live = read(`nfl-team-${abbr}`)?.data?.live;
    const ttl = live ? 2 * MIN : 15 * MIN;
    return cached(`nfl-team-${abbr}`, ttl, async () => {
      const lower = abbr.toLowerCase();
      const [info, sched, news] = await Promise.all([
        getJson(`${ESPN}/teams/${lower}`),
        getJson(`${ESPN}/teams/${lower}/schedule`),
        getJson(`${ESPN}/news?team=${lower}&limit=8`).catch(() => ({ articles: [] })),
      ]);
      const t = info.team;
      const record = (t.record?.items ?? []).map((i) => `${i.description ?? i.type}: ${i.summary}`).join(", ");
      const events = sched.events ?? [];
      const done = events.filter((e) => e.competitions[0].status.type.completed);
      const upcoming = events.filter((e) => !e.competitions[0].status.type.completed);
      const isLive = events.some((e) => e.competitions[0].status.type.state === "in");
      // ESPN's news for a team includes league-wide stories; keep the ones that mention the team.
      const nick = t.name.toLowerCase();
      const headlines = (news.articles ?? [])
        .filter((a) => `${a.headline} ${a.description}`.toLowerCase().includes(nick))
        .slice(0, 4)
        .map((a) => `${a.headline}${a.description ? ` (${a.description})` : ""}`);
      return {
        live: isLive,
        text: [
          `${t.displayName}. Record: ${record || "no games yet"}.`,
          done.length ? `Results so far: ${done.map((e) => gameLine(e, abbr)).join("; ")}.` : "",
          upcoming.length ? `Next games: ${upcoming.slice(0, 3).map((e) => gameLine(e, abbr)).join("; ")}.` : "",
          headlines.length ? `Recent headlines: ${headlines.join(" | ")}` : "",
        ].filter(Boolean).join("\n"),
      };
    });
  }

  const standings = () => cached("nfl-standings", 30 * MIN, async () => {
    const j = await getJson(ESPN_STANDINGS);
    const lines = [];
    const walk = (n) => {
      if (n.standings?.entries?.length) {
        const rows = n.standings.entries.map((e) => {
          const s = Object.fromEntries(e.stats.map((x) => [x.name, x.displayValue]));
          return `${e.team.abbreviation} ${s.wins}-${s.losses}${s.ties && s.ties !== "0" ? `-${s.ties}` : ""}`;
        });
        lines.push(`${n.name}: ${rows.join(", ")}`);
      }
      (n.children ?? []).forEach(walk);
    };
    walk(j);
    return lines.join("\n");
  });

  const scoreboard = () => cached("nfl-scoreboard", 5 * MIN, async () => {
    const j = await getJson(`${ESPN}/scoreboard`);
    const games = (j.events ?? []).map((e) => {
      const c = e.competitions[0];
      const [a, b] = c.competitors;
      const sc = (x) => (typeof x.score === "object" ? x.score?.displayValue : x.score) ?? "";
      const st = c.status.type;
      return st.state === "pre"
        ? `${e.shortName}: ${when(e.date)} Central`
        : `${e.shortName}: ${a.team.abbreviation} ${sc(a)}, ${b.team.abbreviation} ${sc(b)} (${st.shortDetail})`;
    });
    return `Week ${j.week?.number ?? "?"}: ${games.join("; ")}`;
  });

  // ---------- Weather (Open-Meteo) ----------
  async function weatherFor(place) {
    const key = place.trim().toLowerCase();
    const geo = await cached(`geo-${key}`, 30 * 24 * HOUR, async () => {
      // Open-Meteo matches on the city name, so try "Minneapolis" if "Minneapolis, Minnesota" finds nothing.
      for (const name of [place, place.split(",")[0]]) {
        const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.trim())}&count=5`);
        const region = place.split(",").slice(1).join(",").trim().toLowerCase();
        const hit = (j.results ?? []).find((r) => !region || [r.admin1, r.country, r.country_code].some((x) => x?.toLowerCase().includes(region)))
          ?? j.results?.[0];
        if (hit) return { name: [hit.name, hit.admin1, hit.country_code === "US" ? "" : hit.country].filter(Boolean).join(", "), lat: hit.latitude, lon: hit.longitude };
      }
      throw new Error(`Couldn't find a place called "${place}"`);
    });
    return cached(`weather-${key}`, 30 * MIN, async () => {
      const g = geo.data;
      const q = new URLSearchParams({
        latitude: g.lat, longitude: g.lon, timezone: "auto", forecast_days: "3",
        temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
        current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      });
      const w = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
      const c = w.current;
      const days = w.daily.time.map((d, i) => {
        const label = i === 0 ? "Today" : new Date(`${d}T12:00`).toLocaleDateString("en-US", { weekday: "long" });
        return `${label}: ${WEATHER_CODES[w.daily.weather_code[i]] ?? "mixed"}, high ${Math.round(w.daily.temperature_2m_max[i])}°F, low ${Math.round(w.daily.temperature_2m_min[i])}°F, ${w.daily.precipitation_probability_max[i]}% chance of rain or snow`;
      });
      return `${g.name}: right now ${Math.round(c.temperature_2m)}°F (feels like ${Math.round(c.apparent_temperature)}°F), ${WEATHER_CODES[c.weather_code] ?? "mixed"}, wind ${Math.round(c.wind_speed_10m)} mph. ${days.join(". ")}.`;
    });
  }

  // ---------- What a friend gets ----------

  // Real, current facts added to the system prompt at the start of a call (fixed for the call, so caching holds).
  async function briefing(c) {
    const k = c.knows ?? {};
    const parts = [];
    if (k.nflTeam) {
      try {
        const [team, table] = await Promise.all([teamReport(k.nflTeam), standings()]);
        parts.push(`## ${team.data.text.split(".")[0]} (from ESPN, updated ${ago(team.at)})\n${team.data.text}\nStandings:\n${table.data}`);
      } catch (err) {
        parts.push(`## Football\nYou couldn't get the latest football news right now (${err.message}). Don't make up scores or records.`);
      }
    }
    if (k.home) {
      try {
        const w = await weatherFor(k.home);
        parts.push(`## Weather where you live (updated ${ago(w.at)})\n${w.data}`);
      } catch {
        // Weather is a nice-to-have; leave it out if it can't be fetched.
      }
    }
    if (!parts.length && !k.web) return "";
    return `# What's going on (real and current)\nThese are real facts as of today. Use them naturally, like something you read in the paper or saw on TV. Don't recite them like a list.\n\n${parts.join("\n\n")}`;
  }

  // Tools a friend can use during the call. Server tools (web search) run on Anthropic's side.
  function tools(c) {
    const k = c.knows ?? {};
    const list = [];
    if (k.nflTeam) {
      list.push({
        name: "football",
        description: "Look up real, current NFL information from ESPN: a team's record, results, schedule and headlines; this week's scores around the league; or the standings. Use it before talking about any game, score, record or player news you aren't sure of.",
        eager_input_streaming: true,
        input_schema: {
          type: "object",
          properties: {
            what: { type: "string", enum: ["team", "scores", "standings"], description: "team: one team's record, results, schedule and news. scores: this week's games around the league. standings: every division." },
            team: { type: "string", description: "For what=team: a team name or abbreviation, like Vikings or GB." },
          },
          required: ["what"],
        },
      });
    }
    if (k.home || k.web) {
      list.push({
        name: "weather",
        description: "Get the real current weather and 3-day forecast for any town or city.",
        eager_input_streaming: true,
        input_schema: {
          type: "object",
          properties: { place: { type: "string", description: 'Like "Minneapolis, Minnesota" or "Phoenix".' } },
          required: ["place"],
        },
      });
    }
    if (k.web) list.push({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
    return list;
  }

  async function runTool(name, input) {
    if (name === "football") {
      if (input?.what === "scores") return (await scoreboard()).data;
      if (input?.what === "standings") return (await standings()).data;
      const team = await findTeam(input?.team);
      if (!team) return `No NFL team matches "${input?.team}".`;
      return (await teamReport(team.abbr)).data.text;
    }
    if (name === "weather") {
      if (typeof input?.place !== "string" || !input.place.trim()) return "Say which place.";
      return (await weatherFor(input.place)).data;
    }
    return `Unknown tool ${name}.`;
  }

  // Keeps followed teams and hometown weather fresh while the app is open, so calls start with current info.
  function startRefreshing(listFriends) {
    const tick = async () => {
      for (const c of listFriends()) {
        if (c.active === false || !c.knows) continue;
        if (c.knows.nflTeam) await teamReport(c.knows.nflTeam).catch(() => {});
        if (c.knows.home) await weatherFor(c.knows.home).catch(() => {});
      }
      await standings().catch(() => {});
      // Check again in 2 minutes during a game, otherwise in 15.
      const anyLive = listFriends().some((c) => c.knows?.nflTeam && read(`nfl-team-${c.knows.nflTeam}`)?.data?.live);
      setTimeout(tick, anyLive ? 2 * MIN : 15 * MIN).unref?.();
    };
    setTimeout(tick, 5000).unref?.();
  }

  return { briefing, tools, runTool, startRefreshing };
}
