# Call Joe

Desktop voice and video calls with AI friends powered by Claude. Joe Tucker ("Joe Dirt" to his friends) is the first. Pick a friend, click Call or Video, talk out loud, and they talk back. Each one remembers you between calls.

## Setup (Windows)

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. In this folder, run `npm install`.
3. Run `powershell -ExecutionPolicy Bypass -File make-shortcut.ps1` to put a **Call Joe** shortcut on the desktop.
4. Run `powershell -ExecutionPolicy Bypass -File voice\setup-chatterbox.ps1` once. Every friend talks with a voice cloned from a clip, so Chatterbox is required. It needs an NVIDIA graphics card.
5. For video calls, also run `powershell -ExecutionPolicy Bypass -File video\setup-ditto.ps1` once.
6. Open the shortcut. On first launch, paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys).

## Adding friends

Open Claude Code in this folder and type `/new-contact`, then give Claude a name, a few sentences about who they are, a short voice clip and a face picture. Details are in `docs/building-a-contact.md`.

## Settings (⚙ on the friends list)

Opens in its own tablet-style window (`settings.html`), laid out like a phone: a clock and 🔔 notifications at the top (new voicemails, friends who need a voice clip), and tabs at the bottom:
- **Friends:** every friend, with an Active switch. Only active friends show on the friends list and call you; turning a friend off keeps their memory. Each friend's own page will go here later.
- **Voicemail:** messages friends left when you missed or declined their call, with play buttons.
- **Calls:** interrupt by talking, on or off.
- **Looks:** a wallpaper (presets, or your own picture) for Call Joe and Settings, and the call screen style: Classic (the default) or Photo, where the friend's picture fills the screen with their name across it.
- **Account:** change your Anthropic API key.

Changes show up in the main window right away.

## Each friend's settings (⚙ on their call screen)

- **Calls you:** how often this friend rings you while the app is open: never, now and then, or often. The "Try it" button makes them call in a few seconds.
- **Brain:** Haiku (fastest, cheapest), Sonnet (default), or Opus (deepest). Their notes about you are always written by Opus.
- **Voice:** each friend's voice is cloned by Chatterbox, for free on your PC, from a 10–20 second clip. Pick a saved voice, or record or upload a new clip. Only use voices you have permission to copy. A friend can't be called until they have a voice.
- **Video calls (🎥):**
  - The friend's face is animated from one picture, on your NVIDIA graphics card.
  - Run `powershell -ExecutionPolicy Bypass -File video\setup-ditto.ps1` once to install it, then upload a face picture in settings. Use a made-up face, not a real person.
  - You can switch between video and voice during a call.

## Files

- `contacts/<id>/persona.md` — who each friend is (Joe is `contacts/joe/`). `contacts/_call-rules.md` holds the phone and safety rules every new friend gets.
- `tools/contact.py` — builds and manages friends: persona, voice clip, face picture.
- `server.mjs` — local server that talks to Claude and runs the voice and face engines.
- `index.html` — the friends list and call screen.
- `voice/` — the Chatterbox installer and its local voice server.
- `video/` — the Ditto installer, the face server for video calls, and the speed-ups that make it fast enough to run live.
- `data/` — your API keys, each friend's memory notes and call logs (`data/contacts/<id>/`), voice samples and face pictures. Never committed.
- `docs/credits.md` — where each friend's voice clip and picture came from, and their licenses.
- `docs/building-a-contact.md` — how to add a friend, with Claude or by hand.
- `docs/plan-contacts.md` — the original plan for more friends.
- `docs/session-notes.md` — how Call Joe was built, the decisions behind it, and the rules for keeping every friend themselves as they learn.
