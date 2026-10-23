# Session notes: building Call Joe

First build session: October 23, 2026, with Claude Code.

## The goal

An AI friend on the Windows desktop that you "call" and talk to out loud, like phoning a buddy. Not a chat window and not an assistant.

## Who Joe is

Joe Dirt: funny, a little redneck, and dead serious about his friends' and family's well-being. He's married to Brandy, a sweet, old-fashioned southern belle with some hillbilly in her, and they have three little kids: Bubba (6), Daisy Mae (4) and baby Tater (1). They also have a dog named Dirt Nap. His friendship with the user started fresh: on the first call he gets to know them.

All of this lives in `persona.md`.

## How it works

1. `launch.ps1` starts `server.mjs` in the background (if it isn't already running) and opens `index.html` as its own app window in Chrome or Edge.
2. The browser's speech recognition turns your voice into text and sends it to the server once you pause.
3. The server sends the call so far to Claude and streams Joe's reply back as he says it.
4. The page speaks each sentence as soon as it arrives, using either a Windows voice or ElevenLabs.
5. When you hang up, Opus reads the call and updates Joe's memory notes about you in `data/memory.json`. The full transcript goes to `data/call-log.txt`.
6. The server shuts itself down about 3 minutes after the window closes. If a call was still open, it saves it first.

## Decisions we made, and why

| Decision | Why |
|---|---|
| **Sonnet 5.5 is the default model**, with thinking off (`between_tools`) and effort `low` | On a call, a pause before Joe answers feels like a bad line. Sonnet is quick but still sharp enough to sound like a real buddy. |
| **Haiku and Opus can be picked in ⚙ settings** | Haiku is cheapest and fastest. Opus is deepest, but slower and pricier. The user decides. |
| **Opus always writes the memory notes** | It happens once per call (about a penny), and good notes are what make Joe remember you well. |
| **Prompt caching is on, and the system prompt is built once per call** | Every reply resends the whole call. Caching cuts that cost a lot, but only if the system prompt doesn't change mid-call. |
| **Windows voices are free, and ElevenLabs is optional** | No built-in voice has a southern accent, and ElevenLabs does. If ElevenLabs fails mid-call, Joe switches to a Windows voice so he never goes silent. |
| **API keys stay on the server and never reach the page** | The page only receives Joe's text and audio. Keys live in `data/config.json`. |
| **`data/` is never committed** | It holds API keys, Joe's notes about the user, and call logs. That's private. |
| **Safety is built into the persona** | Joe drops the jokes and points to 988 or 911 if the user talks about hurting themselves or being in danger. He's honest that he's an AI if sincerely asked. He nudges the user toward their real-life people. |

Rough costs, for a 30-minute call with caching on: Haiku under 1¢, Sonnet about 15¢, Opus about 30¢. ElevenLabs is billed separately (about $5–22 a month).

## Rule: keep Joe, Joe

Joe has to stay the same friend while he keeps learning about the user. Any change to this app has to keep these working:

1. **`persona.md` is who Joe is.** Change his personality or family on purpose, never as a side effect of other work.
2. **The memory system stays.** That means `data/memory.json`, the Opus memory writer in `hangUp()`, and the memory section of the system prompt. Even if models, prompts or storage change, Joe must still read his notes at the start of each call and update them after it.
3. **Never wipe or reset `data/`.** If the memory format changes, convert the existing notes into the new format. Joe must not forget the user.
4. **Joe's made-up life details are part of memory.** The notes keep what he has said about Brandy, the kids and his life, so he stays consistent from call to call.
5. **Swapping the model or voice must not change who Joe is.** A new model or voice gets the same persona and the same notes.
6. **Test a real call after any change** to confirm Joe still sounds like Joe and remembers the last call.

## Still open (as of October 23, 2026)

- No real call has been tested yet. That needs the user's Anthropic API key.
- ElevenLabs audio hasn't been tested with a real key.
- The app still needs a permanent folder on the PC and a desktop shortcut (`make-shortcut.ps1`).
