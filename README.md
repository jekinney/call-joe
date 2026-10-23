# Call Joe

A desktop "phone call" with Joe Dirt, an AI buddy powered by Claude. Click Call, talk out loud, and Joe talks back. He remembers you between calls.

## Setup (Windows)

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. In this folder, run `npm install`.
3. Run `powershell -ExecutionPolicy Bypass -File make-shortcut.ps1` to put a **Call Joe** shortcut on the desktop.
4. Open the shortcut. On first launch, paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys).

## Settings (⚙ in the app)

- **Joe's brain:** Haiku (fastest, cheapest), Sonnet (default), or Opus (deepest). His notes about you are always written by Opus.
- **Voice service:**
  - Free Windows voices.
  - **Chatterbox:** free voice cloning on your own PC. It needs an NVIDIA graphics card to keep up on a call. Run `powershell -ExecutionPolicy Bypass -File voice\setup-chatterbox.ps1` once to install it, then record or upload about 15 seconds of the voice you want, using only voices you have permission to copy.
  - ElevenLabs, for realistic voices. Needs an ElevenLabs API key.

## Files

- `persona.md` — who Joe is. Edit it to change his personality or family.
- `server.mjs` — local server that talks to Claude and ElevenLabs.
- `index.html` — the call screen.
- `voice/` — the Chatterbox installer and its local voice server.
- `data/` — your API keys, Joe's memory notes, call logs and voice samples. Never committed.
- `docs/session-notes.md` — how Joe was built, the decisions behind it, and the rules for keeping Joe himself as he learns.
