# Call Joe

Desktop voice and video calls with AI friends powered by Claude. Joe Dirt is the first. Pick a friend, click Call or Video, talk out loud, and they talk back. Each one remembers you between calls.

## Setup (Windows)

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. In this folder, run `npm install`.
3. Run `powershell -ExecutionPolicy Bypass -File make-shortcut.ps1` to put a **Call Joe** shortcut on the desktop.
4. Open the shortcut. On first launch, paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys).

## Adding friends

Open Claude Code in this folder and type `/new-contact`, then give Claude a name, a few sentences about who they are, a short voice clip and a face picture. Details are in `docs/building-a-contact.md`.

## Each friend's settings (⚙ on their call screen)

- **Brain:** Haiku (fastest, cheapest), Sonnet (default), or Opus (deepest). Their notes about you are always written by Opus.
- **Voice service:**
  - Free Windows voices.
  - **Chatterbox:** free voice cloning on your own PC. It needs an NVIDIA graphics card to keep up on a call. Run `powershell -ExecutionPolicy Bypass -File voice\setup-chatterbox.ps1` once to install it, then record or upload about 15 seconds of the voice you want, using only voices you have permission to copy.
  - ElevenLabs, for realistic voices. Needs an ElevenLabs API key.
- **Video calls (🎥):**
  - The friend's face is animated from one picture, on your NVIDIA graphics card.
  - Run `powershell -ExecutionPolicy Bypass -File video\setup-ditto.ps1` once to install it, then upload a face picture in settings. Use a made-up face, not a real person.
  - Video calls need the Chatterbox or ElevenLabs voice.
  - You can switch between video and voice during a call.

## Files

- `contacts/<id>/persona.md` — who each friend is (Joe is `contacts/joe/`). `contacts/_call-rules.md` holds the phone and safety rules every new friend gets.
- `tools/contact.py` — builds and manages friends: persona, voice clip, face picture.
- `server.mjs` — local server that talks to Claude and ElevenLabs.
- `index.html` — the friends list and call screen.
- `voice/` — the Chatterbox installer and its local voice server.
- `video/` — the Ditto installer, the face server for video calls, and the speed-ups that make it fast enough to run live.
- `data/` — your API keys, each friend's memory notes and call logs (`data/contacts/<id>/`), voice samples and face pictures. Never committed.
- `docs/building-a-contact.md` — how to add a friend, with Claude or by hand.
- `docs/plan-contacts.md` — the original plan for more friends.
- `docs/session-notes.md` — how Call Joe was built, the decisions behind it, and the rules for keeping every friend themselves as they learn.
