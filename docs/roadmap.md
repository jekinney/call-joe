# Roadmap: shipping Call Joe to other people

Written October 23, 2026. This is a plan, not built yet.

## Decisions so far (October 23, 2026)
- **Ship with today's engines:** Chatterbox for voices and Ditto for video. No separate voice engine for PCs without NVIDIA cards (see "Hardware tiers").
- **Joe Tucker ships as the default friend.** (Renamed from "Joe Dirt" on October 23, 2026. He still goes by the nickname on calls.) He's always there on a fresh install or a reinstall. Other starter friends (Rosa, George and more) can be added from a list.
- **A friend's personality is permanent once it's created.** There's no editing it, and no wiping and starting over. Users can only add new friends, and change a friend's picture or voice.
- **Friends can be connected to each other** (mom, brother, spouse, friend and so on). Each kind of connection has its own rules for what they'd know about you from each other.

The goals:

1. A Windows installer. People add their own Claude (Anthropic) API key, and everything stays on their PC.
2. Phone and tablet apps that call the same friends.
3. People create and edit friends themselves, inside the app, with Claude doing the writing through their own key.

## Where things stand today

| Piece | Today | Needed to ship |
|---|---|---|
| App | `server.mjs` (Node) and `index.html`, opened in a Chrome app window by `launch.ps1` | A real desktop app with its own installer and window |
| Voice | Chatterbox in `voice/.venv`, installed by a PowerShell script | Downloaded on first run, with a progress bar |
| Video | Ditto in `video/.venv` plus our speed-ups, installed by a script | Same, and turned off when the hardware can't run it |
| API key | Plain text in `data/config.json` | Encrypted on the PC |
| Making friends | `/new-contact` in Claude Code and `tools/contact.py` | A "New friend" wizard in the app |

## 1. Windows installer (local-only)

### Packaging
- **Wrap the app in Electron.** It bundles Node, so there's nothing extra to install. It gives a proper app window, a taskbar and tray icon (so friends can still call while the window is closed to the tray), and a standard installer through electron-builder (NSIS).
  - **Tauri** makes a much smaller download, but the server would need a Node "sidecar" or a rewrite. Electron is the shorter path because `server.mjs` runs as-is.
- **Don't put the engines in the installer.** Chatterbox and Ditto, with PyTorch and their models, are 5–8 GB. The installer should be small, about 150 MB. Then a first-run step:
  1. Check the hardware: an NVIDIA card, how much video memory it has, and the driver version.
  2. Download a ready-made Python environment for the voice engine (and the video engine, if the card supports it), plus the model files.
  3. Run a self-test: one spoken sentence, and one video frame if video is on.
- **Ship prebuilt Python environments** instead of running `pip`/`uv` on people's PCs. Today's setup scripts depend on the internet and on package versions that change; a fixed bundle makes installs repeatable. Keep our two fixes in that bundle: `setuptools<81` for Chatterbox's watermark package, and the NumPy blend patch for Ditto.

### Hardware tiers

The latest Steam hardware survey (July 2026) puts NVIDIA at about 73% of PCs. That's gamers, so typical home PCs and laptops will have a lower share. Plan for three tiers:

| Tier | Hardware | What works |
|---|---|---|
| Full | NVIDIA card with 8 GB or more of video memory (this PC has a 16 GB RTX 4080 Super) | Voice and video calls |
| Voice only | NVIDIA card with 4–6 GB | Cloned voices; video off |
| Basic | No NVIDIA card (most laptops, AMD, Intel) | **Decided: same engines, no special tier.** Chatterbox runs on the processor, so replies are slower (an estimated 2–4 s extra; to be measured), and video is off. The installer says this plainly before installing. |

### API key
- A first-run screen: paste your Anthropic key. The app checks it (as `/api/key` does today) and links to console.anthropic.com.
- **Store it with Electron `safeStorage`**, which uses Windows' built-in encryption (DPAPI) tied to the user's Windows account, instead of plain text in `config.json`. Never put it in logs.
- Show a rough cost, like the estimates in `docs/session-notes.md`: Sonnet is about 15¢ per 30-minute call with caching. Consider a monthly spending warning.

### Signing and updates
- **Code signing** stops the "unknown publisher" warning:
  - **Azure Artifact Signing** (formerly Trusted Signing) costs about $9.99 a month, but individuals can only use it in the USA and Canada. One May 2026 report says new individual sign-ups are paused, so check Microsoft's pages first.
  - **An OV certificate** costs about $150–300 a year and works worldwide.
  - Either way, SmartScreen still warns about a new app until it builds download history. Expect warnings during the beta.
- **Auto-update** with electron-updater, from GitHub Releases. The repo is private now, so updates would need a public releases repo or a small update server.
- **Uninstall** asks whether to keep the user's friends, memories and recordings.

### Legal, licensing and safety (before any public release)
- **Software licenses:**
  - Chatterbox: MIT.
  - Ditto's code: Apache-2.0.
  - **Ditto's model files:** the HuggingFace page says the repository is "released under the Apache-2.0 license," but the model card has no license field. Good enough for testing. Get written confirmation, or a LICENSE file in the model repo, before redistributing.
  - Ship a credits and licenses screen. `docs/credits.md` is the start of it.
- **Starter friends:**
  - **Renamed to Joe Tucker** on October 23, 2026, so the friend's name is no longer the movie character's (a 2001 Columbia Pictures film). His personality still mentions the nickname "Joe Dirt"; if that's a concern for the public release, it can be dropped from the shipped starter version.
  - Earlier note: Risk to keep in mind: a trademark complaint could force a rename after launch. A lawyer's quick check before a public release is cheap insurance. Our Joe is an original character who shares the name, and he doesn't use the actor's voice or face.
  - Joe's and Rosa's voice clips are CC BY 3.0, which allows redistribution with credit. The face pictures are AI-generated. Keep the credits.
- **Voice cloning:**
  - Users tick "I have permission to use this voice" before every clone.
  - Chatterbox already watermarks its audio invisibly (Resemble's Perth watermark). Mention it in the privacy notice.
  - Reject clips of known celebrities where possible, or at least warn.
- **Privacy notice:**
  - Conversations are sent to Anthropic through the user's own key.
  - Memory, transcripts, voices and pictures stay on the PC, in `data/`.
  - Speech recognition currently uses the browser's built-in service, which sends audio to Google or Microsoft. **Disclose this, or replace it with a local speech recognizer** (for example, Whisper on the graphics card), which would also make it work offline.
- **Age and safety:**
  - Anthropic allows products used by minors only with extra safeguards (age verification, moderation, a child-safety system prompt, and laws like COPPA).
  - For a companion app, the simplest path is **18+ only**, with an age confirmation at first run.
  - Keep the call rules in `contacts/_call-rules.md`: honest about being an AI, crisis help (988/911), and nudging toward real-life people.
  - Re-check Anthropic's usage policy for companion-style apps before launch.

## 2. Phone and tablet apps

Phones can't run Chatterbox or Ditto. There are two ways to do it:

### A. The phone is a remote for the user's PC (keeps everything local) — recommended first
- The PC does all the work. The phone shows the same friends list and makes calls, and the audio and video stream from the PC.
- **Step 1: an installable mobile web app (PWA).** `index.html` is already a web page. It needs a phone-sized layout, and login and pairing.
- **Pairing:** the PC shows a QR code, and the phone scans it to get a device token. Every request after that is checked. Today the server only listens on the PC itself (127.0.0.1) and has no login, so it **must not be opened to the network without this.**
- **Reaching the PC away from home:**
  - **Tailscale** is the easiest: free for personal use, encrypted, and no ports to open.
  - Or run a small relay service.
  - At home on the same Wi-Fi, HTTPS with a local certificate works.
- **Step 2: store apps.** Wrap the web app with Capacitor for iOS and Android. That adds real push notifications, so a friend's random call can ring a locked phone. The PC would send the push.
- Speech recognition on phones: Safari and Chrome on phones handle it differently. A local recognizer on the PC (see above) avoids that.

### B. Hosted servers (works without the PC, but no longer "local")
- Graphics-card servers run the voice and video engines. Phones and basic PCs connect to them.
- You'd be running servers and paying for graphics-card time, storing users' memories, and taking on the privacy and security that comes with that. Probably a paid tier later, not the first release.

## 3. Friends: starter friends, new friends, and what can change

Most users won't have Claude Code, so `/new-contact` moves into the app.

### The rules
| Can a user... | Answer |
|---|---|
| Add a starter friend from our list | Yes |
| Create a new friend from their own description | Yes |
| Change a friend's picture | Yes, any time |
| Change a friend's voice | Yes, any time (permission checkbox again) |
| Connect friends to each other | Yes, when creating a friend, or later |
| Edit a friend's personality after it's created | **No.** It's permanent. |
| Wipe a friend's memory, or reset and start over | **No.** Memory only grows through calls. |
| Delete a friend | No delete. See "Hiding a friend" under open questions. |

This replaces the "edit a friend by prompt" idea in an earlier version of this plan. The `tools/contact.py persona` and `remove` commands become developer-only, and the app never offers them.

### Starter friends
- **Joe Tucker is always installed and enabled.** On a reinstall that keeps the user's data, he's the same Joe with all his memories. On a clean install, he starts fresh.
- **The other starter friends** (Rosa, George, and more later) are switched on from an "Add a friend" list. Each one ships with:
  - a finished personality (like `contacts/rosa/persona.md`),
  - a licensed voice clip and an AI-made face (credited in `docs/credits.md`),
  - **starter memory:** a few facts they already "know" when switched on. For example, Rosa knows George, and her own family and home. This starts in `memory.json` alongside what they learn on calls, and it's never about the user, since they haven't met.
  - their connections to other starter friends. If a user switches on Rosa and George, they're automatically connected as a married couple.

### Creating a new friend
1. **Who they are:** a name, the user's own description of their personality, and their **role in the user's life** (mom, dad, brother, sister, friend and so on; see section 4).
2. **Voice:** upload or record a clip, with the permission checkbox. At least 5 seconds of speech.
3. **Face (optional):** upload a picture, with the checkbox. It's cropped automatically.
4. **Connections (optional):** "This is my sister. She's Mom's daughter and Joe's friend."
5. **Personality:** Claude writes it from the user's description, using their key. The `/new-contact` instructions are the system prompt. The user reads it and asks for changes as often as they like. Nothing is saved yet.
6. **Try before it's permanent:** a short test call. It isn't saved to memory, so they can hear how the friend talks.
7. **Finalize:** a clear warning: "This personality is permanent. You can change their picture and voice later, but not who they are." Then it's locked.

The final personality is the user's own description (or the starter personality), plus three blocks that are always added:
- the shared call rules (`contacts/_call-rules.md`),
- the **role rules** for their role in the user's life (section 4),
- the **connection rules** for each friend they're connected to (section 4).

The role and connection rules stay in their own files, so the app can improve them without touching the locked personality.

### Changing a picture or voice later
- In the friend's ⚙ settings. Same checks as creating: permission, at least 5 seconds of speech, a face it can find.
- Their personality and memory don't change. Only how they look or sound.

### Friend files (import and export)
- Back up or move friends to a new PC as a single file: personality, voice, picture, memory and connections.
- **Sharing a friend with someone else** gives them the personality, voice and picture, but never the memory. It's a fresh start, and it's locked the same way.
- Imports ask for the same permission checks.

## 4. Connecting friends: roles and what they'd know

**Status: the core is built (October 23, 2026).** Roles, role rules, connections and filtered news work today; see "What's built" at the end of this section. The share-everything link (`linkedNews()`) is gone.

Before this, Rosa and George shared *everything* in each other's notes. With real family roles that's wrong. Your brother shouldn't know what you only told Mom, and your sister would remember that your car looks cool, but probably not its model. So connections need rules.

### Two layers
1. **A friend's role in the user's life:** mom, dad, brother, sister, son, daughter, grandma, grandpa, aunt, uncle, cousin, spouse or partner, best friend, friend, coworker, neighbor, or "other" (the user describes it).
2. **Connections between friends:** "Rosa and George are married," "Mom is Sis's mother," "Joe and Dave are buddies." This tells each friend who the other one is, so they can talk about each other ("Your mother called me yesterday…").

### Role rules: what each role would plausibly know about you
Each role has a short rules prompt. It's added to every friend with that role, and it decides **which of your news reaches them from other friends**. Some starting examples, which you'll want to tune:

| Role | Would likely hear about | Wouldn't hear about, or only vaguely |
|---|---|---|
| Mom | Health (including periods and pregnancy), relationships, money worries, how you're feeling, big plans | Details you'd only tell a friend, like party stories |
| Dad | Work, money, house and car (make and model, repairs), big life events, health in general | Intimate health details, relationship drama details |
| Sister | Relationships, how you're feeling, style, plans, the gossip | Technical details: a car's "cool red one with a loud stereo," not its make, model or engine |
| Brother | Sports, jokes, work in general, big events, cars and gear in detail | Periods and intimate health, relationship details beyond "seeing someone" |
| Spouse or partner | Almost everything | Things you've told someone in confidence |
| Best friend | Almost everything you'd tell a friend | Family-only matters |
| Friend or coworker | Only what you'd mention casually or in a group | Health, money and family problems, unless they're public knowledge |

- These are defaults, written as plain-English prompts in files (for example `contacts/_roles/mom.md`). The user can adjust a role's rules for their own family, since every family is different.
- Keep the defaults to "what this person would plausibly hear" rather than mean stereotypes, and let users tune them. Your sister example ("knows it's cool, not what model it is") is the right flavor: a realistic gap in what they'd know, not a put-down.

### How the sharing works
After each call, the memory writer (Opus, in `hangUp()`) already updates that friend's notes. With connections, it also writes **a short "news that would travel" note** for each connected friend:
- **Input:** the newest call, the role rules of the friend who'd receive it, and how the two friends are connected.
- **Output:** only what would plausibly reach that person, phrased the way they'd hear it ("Jason's been feeling under the weather"), not as a transcript.
- **Saved** as `data/contacts/<receiver>/heard-from/<sender>.md`, and added to the receiver's next call.
- **Anything the user said "don't tell anyone" stays private,** whatever the role. The memory writer looks for that.
- **A friend never sees another friend's raw notes,** only the filtered news. This replaces today's `linkedNews()`.

### Also needed
- **The user sees what travels.** A friend's settings show "What Mom has heard from others," so nothing about them is shared without them being able to see it.
- **Directional:** news can flow from Sis to Mom but not back, depending on the roles.
- **Cost:** about one extra small Claude call per connected friend after each call. It could use Haiku to keep it cheap.
- **Moving Rosa and George over:** they become a "married" connection between two "friend" roles. Their current share-everything link becomes filtered news like everyone else's.

### What's built (October 23, 2026)
| Piece | Where | Notes |
|---|---|---|
| Role rules | `contacts/_roles/<role>.md`: friend, best-friend, spouse, mom, dad, sister, brother, grandparent, coworker, neighbor | Plain English: who they are to you, what news would reach them, what wouldn't. Added to the friend's instructions. Tune freely; add a file for a new role. |
| A friend's role | `role` in contact.json; `tools/contact.py role <id> <role>`, or `create --role` | Friends without a role (Joe today) get no role section, so their instructions are unchanged. |
| Connections | `links` in contact.json: `[{ id, relation, type? }]`; `tools/contact.py link` | The relation says what the other friend is to them ("your husband"). |
| Connection rules | `contacts/_connections/<type>.md`: married, parent-child, in-laws, siblings, grandparent, friends, coworkers, neighbors | Reusable prompts: how the two are with each other, what they pass along about you, and what stays private. Similar relationships share a file, picked from the relation words ("wife" → married, "mother-in-law" → in-laws, "mom" → parent-child), or set with `link --type`. Used in each friend's instructions about the other, and as the main guide for the news filter (the receiver's role can only narrow it). Tested: Rosa knew the dog's name (Biscuit), his vet visit and a Duluth trip from George's call, and a Christmas gift secret didn't reach her. |
| Filtered news | `passNews()` in `server.mjs`, run after each call by Haiku 5.5 | For each connected friend: what would plausibly travel, given the connection and the receiver's role. Skips anything said in confidence. Saved to `data/contacts/<receiver>/heard-from/<sender>.md` and added to the receiver's next call. Tested: a promotion the user asked to keep quiet didn't reach George; the meatball recipe and a Phoenix trip did. |
| Starting over | `tools/contact.py reset <id>` | Developer-only. Archives memory, call log and heard-from news; never deletes. |

**Still to do:** the in-app "What Mom has heard from others" view; directional rules (news flows one way only); starter memory; tuning the role files with real family examples.

## 5. Live knowledge: real sports, weather and web search

**Status: built October 23, 2026** (`knowledge.mjs`). Friends can talk about what's actually happening instead of guessing.

### What a friend can know
Set per friend in contact.json as `knows`, with `tools/contact.py knows <id> [--nfl-team MIN] [--home "Town, State"] [--web]`:

| Setting | At the start of every call (no waiting) | During the call (a lookup tool) |
|---|---|---|
| `nflTeam` | A briefing: record, every result so far, the next games, team headlines, division standings | Any team's record, results, schedule and news; this week's scores; standings |
| `home` | The weather where they live: now, plus a 3-day forecast | The weather anywhere ("what's it like in Phoenix?") |
| `web` | — | Web search (Anthropic's server tool, up to 3 searches per reply), for recipes, prices and anything else |

- Before a lookup, the friend says one short line ("Hang on, let me look"), which is spoken while the lookup runs. They answer in a sentence or two, in their own words, and never make up scores, prices or forecasts.
- Friends without `knows` (Joe today) get no tools and no briefing, so nothing changes for them.

### Data sources
| Data | Source | Cost | Cached for |
|---|---|---|---|
| NFL teams, schedules, scores, news | ESPN's public site API (`site.api.espn.com`; no key; unofficial, so it could change) | Free | 15 minutes (2 minutes during a live game); the team list 7 days |
| Standings | ESPN (`/apis/v2/.../standings?level=3`) | Free | 30 minutes |
| Weather | Open-Meteo forecast and geocoding (no key) | Free for non-commercial use; a paid plan is needed for a commercial release | 30 minutes; place lookups 30 days |
| Web search | Anthropic `web_search_20260209` | About $10 per 1,000 searches, plus tokens | Not cached |

- **Cache:** `data/cache/*.json`, kept across restarts. If a source is down, the last good data is used.
- **Background refresh:** while the app is open, followed teams and hometown weather refresh every 15 minutes (every 2 during a live game), so calls start with fresh data.

### For shipping
- **ESPN's API is unofficial.** For a public release, consider a licensed sports-data provider, or keep ESPN behind a fallback with clear "couldn't get scores" handling (already there).
- **Open-Meteo** requires a paid plan for commercial use.
- **The in-app friend wizard** needs a "What do they keep up with?" step: a team, a hometown, web search on or off.
- More feeds later: other sports (ESPN has NBA, MLB, NHL and college on the same API), local news, a horoscope, stock prices.

## Suggested order

| Step | What | Rough size |
|---|---|---|
| 1 | In-app friend wizard with test call and finalize; starter friends list; picture and voice changes (move `tools/contact.py` into the server) | 1–2 weeks |
| 1b | Roles, connections and filtered news (section 4). **Core built October 23, 2026**; still to do: the "what they've heard" view, directional rules, starter memory | under 1 week left |
| 1c | Live knowledge (section 5). **Built October 23, 2026**; for shipping: licensed data sources and a wizard step | a few days |
| 2 | Local speech recognition (Whisper) for privacy and offline use | about 1 week |
| 3 | Electron app: encrypted key, first-run downloads, hardware check and tiers | 2–3 weeks |
| 4 | Signing, auto-update, licenses screen, privacy notice, 18+ check; private beta with a few friends' PCs | about 1 week, plus beta time |
| 5 | Phone web app as a remote for the PC (pairing, login, Tailscale) | 2–3 weeks |
| 6 | Store apps with push notifications for incoming calls | 2–4 weeks, plus store review |

## Open questions
1. **Hiding a friend.** If someone regrets a friend they made, should there be a "hide from my list" option? Nothing would be deleted, and it could be undone. Without it, a list could fill up with friends the user never calls.
2. Confirm the license for Ditto's model files with the authors.
3. Is it free, or is there a paid version someday? This decides whether hosted servers (2B) ever make sense.
4. Whether the shipped starter Joe keeps the "Joe Dirt" nickname (he's named Joe Tucker now).
5. Should starter memory be shown to users, or kept as a surprise ("Rosa already knows she's married to George")?

## Sources
- [Microsoft: code signing options for Windows apps](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Azure Artifact Signing pricing](https://azure.microsoft.com/pricing/details/artifact-signing/)
- [Indie developer guide to cheap OV/EV certificates (May 2026)](https://gabrielmoraru.com/obtaining-cheap-ev-ov-certificates-singing-your-application/)
- [Steam hardware survey, July 2026 (tech-insider)](https://tech-insider.org/steam-hardware-survey-july-2026/)
- [Anthropic: guidelines for organizations serving minors](https://support.claude.com/en/articles/9307344)
- [Ditto model files on HuggingFace](https://huggingface.co/digital-avatar/ditto-talkinghead)
