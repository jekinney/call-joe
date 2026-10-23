# Roadmap: shipping Call Joe to other people

Written October 23, 2026. This is a plan, not built yet. The goals:

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
| Basic | No NVIDIA card (most laptops, AMD, Intel) | Chatterbox on the processor is too slow for live calls. Options: allow Windows voices again in this tier only (no video), or the hosted option in section 2. **Decide this before the beta.** |

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
  - "Joe Dirt" is a movie character's name. Ship a renamed starter friend instead.
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

## 3. Creating and editing friends in the app

Most users won't have Claude Code, so `/new-contact` moves into the app.

### New friend wizard
1. **Who:** a name, a few sentences about them, and optionally a link to an existing friend ("Rosa's husband").
2. **Voice:** upload a clip or record 15 seconds, with the permission checkbox. Same rules as `tools/contact.py`: at least 5 seconds of speech, trimmed and evened out.
3. **Face (optional):** upload a picture, with the checkbox "made-up face, or used with permission". It's cropped around the face automatically. Warn about sunglasses, side views and blurry or small faces.
4. **Personality:** Claude writes it, using the user's key. The `/new-contact` instructions (`.claude/skills/new-contact/SKILL.md`, steps 3–4) become the system prompt for this API call. Claude asks two or three follow-up questions in the wizard, then shows the draft. The user edits it or asks for changes, then approves.
5. **Save:** the same steps as `tools/contact.py create`, `face` and `link`, moved into the server. Then a test line in their new voice.

### Edit a friend by prompt
- Example: "Make Earl grumpier" or "Rosa's grandson just got married."
- Claude rewrites the persona and shows what changed. Nothing changes until the user approves it.
- **Memory is never edited this way**, which keeps the "keep every friend themselves" rules in `CLAUDE.md`.

### Friend files (import and export)
- One file (a zip) per friend, holding the persona, voice clip, face picture and settings, so friends can be backed up, moved to a new PC, or shared.
- **Memory isn't included by default.** It's private, and the person sharing is asked first.
- Importing asks for the same consent checks, since a shared file carries someone's cloned voice.
- Possibly later: a library of starter friends made from licensed voices and AI faces.

## Suggested order

| Step | What | Rough size |
|---|---|---|
| 1 | In-app friend wizard and edit-by-prompt (move `tools/contact.py` into the server) | 1–2 weeks |
| 2 | Local speech recognition (Whisper) for privacy and offline use | about 1 week |
| 3 | Electron app: encrypted key, first-run downloads, hardware check and tiers | 2–3 weeks |
| 4 | Signing, auto-update, licenses screen, privacy notice, 18+ check; private beta with a few friends' PCs | about 1 week, plus beta time |
| 5 | Phone web app as a remote for the PC (pairing, login, Tailscale) | 2–3 weeks |
| 6 | Store apps with push notifications for incoming calls | 2–4 weeks, plus store review |

## Open questions
1. What should basic PCs get (no NVIDIA card)? Windows voices again with no video, hosted voices, or "not supported"?
2. Confirm the license for Ditto's model files with the authors.
3. Is it free, or is there a paid version someday? This decides whether hosted servers (2B) ever make sense.
4. What's the name and the starter friend for the public version, since "Joe Dirt" can't ship?

## Sources
- [Microsoft: code signing options for Windows apps](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Azure Artifact Signing pricing](https://azure.microsoft.com/pricing/details/artifact-signing/)
- [Indie developer guide to cheap OV/EV certificates (May 2026)](https://gabrielmoraru.com/obtaining-cheap-ev-ov-certificates-singing-your-application/)
- [Steam hardware survey, July 2026 (tech-insider)](https://tech-insider.org/steam-hardware-survey-july-2026/)
- [Anthropic: guidelines for organizations serving minors](https://support.claude.com/en/articles/9307344)
- [Ditto model files on HuggingFace](https://huggingface.co/digital-avatar/ditto-talkinghead)
