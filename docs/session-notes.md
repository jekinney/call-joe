# Session notes: building Call Joe

First build session: October 23, 2026, with Claude Code.

## The goal

An AI friend on the Windows desktop that you "call" and talk to out loud, like phoning a buddy. Not a chat window and not an assistant.

## Who Joe is

Joe Dirt: funny, a little redneck, and dead serious about his friends' and family's well-being. He's married to Brandy, a sweet, old-fashioned southern belle with some hillbilly in her, and they have three little kids: Bubba (6), Daisy Mae (4) and baby Tater (1). They also have a dog named Dirt Nap. His friendship with the user started fresh: on the first call he gets to know them.

All of this lives in `contacts/joe/persona.md`. Joe is now the first of any number of friends (contacts). Each has their own persona, voice, face and memory, and they don't know about each other. New friends are built with `/new-contact` (see `docs/building-a-contact.md`).

## How it works

1. `launch.ps1` starts `server.mjs` in the background (if it isn't already running) and opens `index.html` as its own app window in Chrome or Edge.
2. The browser's speech recognition turns your voice into text and sends it to the server once you pause.
3. The server sends the call so far to Claude and streams Joe's reply back as he says it.
4. The page speaks each sentence as soon as it arrives, in the friend's own voice, cloned by Chatterbox on this PC from their voice clip.
5. On a **video call**, each sentence's audio also goes to the face engine (`video/face_server.py`, on port 5176). It animates Joe's face picture to match the audio and streams the frames back while they're drawn. The page plays the audio and draws the matching frame on every screen refresh. While Joe listens, a short idle clip of him blinking and moving slightly loops forward and back.
6. When you hang up, Opus reads the call and updates Joe's memory notes about you in `data/memory.json`. The full transcript goes to `data/call-log.txt`.
7. The server shuts itself down about 3 minutes after the window closes. If a call was still open, it saves it first.

## Decisions we made, and why

| Decision | Why |
|---|---|
| **Sonnet 5.5 is the default model**, with thinking off (`between_tools`) and effort `low` | On a call, a pause before Joe answers feels like a bad line. Sonnet is quick but still sharp enough to sound like a real buddy. |
| **Haiku and Opus can be picked in ⚙ settings** | Haiku is cheapest and fastest. Opus is deepest, but slower and pricier. The user decides. |
| **Opus always writes the memory notes** | It happens once per call (about a penny), and good notes are what make Joe remember you well. |
| **Prompt caching is on, and the system prompt is built once per call** | Every reply resends the whole call. Caching cuts that cost a lot, but only if the system prompt doesn't change mid-call. |
| **Windows voices are free, and ElevenLabs is optional** (replaced later the same day: see "Every friend's voice is cloned from a clip") | No built-in voice has a southern accent, and ElevenLabs does. If ElevenLabs fails mid-call, Joe switches to a Windows voice so he never goes silent. |
| **Chatterbox is the free option for a southern voice** | ElevenLabs costs about $11 a month. Chatterbox (MIT license, from Resemble AI) clones a voice from about 15 seconds of audio and runs on the PC's RTX 4080 Super for free. It uses the Turbo model, its own Python 3.11 in `voice/.venv`, and a helper server on port 5175 that Joe's server starts. Voice samples live in `data/voices/`. Only clone voices you have permission to use. |
| **Video calls use Ditto, a realistic face made from one picture** | Ditto (Ant Group, Apache-2.0) adds natural head movement and blinks. Its PyTorch version runs on the RTX 4080 Super without TensorRT. Out of the box it was too slow (0.7× real time), because every frame went back and forth between the processor and the graphics card. `video/fast_ditto.py` keeps the frames on the card, and `face_server.py` does all graphics-card work on one thread (a new thread per request cost over a second). Now Joe starts talking about 1.2–1.8 s after his voice is ready, at roughly 30 frames per second. `video/patches/blend_init.py` lets Ditto run without Microsoft's C++ compiler. MuseTalk was the backup option. It needs a video of the face and only moves the mouth. |
| **Linked friends share news** | Added October 23, 2026, for Rosa and George Walker (a married couple). `tools/contact.py link` stores `links` in each friend's contact.json. At the start of a call, the server adds the linked friend's memory notes, framed as what they've told each other. Unlinked friends, like Joe, get nothing extra, so their prompts are unchanged. |
| **Every friend's voice is cloned from a clip, by Chatterbox only** | Decided October 23, 2026. Windows voices played inside the browser, so they could never sync with video calls, and they weren't cloned from a clip. ElevenLabs was removed too, because every friend is built from a voice clip the user provides. Both are in the git history if ever wanted again. A friend can't be created (`tools/contact.py create --voice` is required) or called without a voice. If a sentence's voice fails mid-call, the call screen shows the sentence in a notice instead of using a fallback voice. |
| **API keys stay on the server and never reach the page** | The page only receives Joe's text and audio. Keys live in `data/config.json`. |
| **`data/` is never committed** | It holds API keys, Joe's notes about the user, and call logs. That's private. |
| **Safety is built into the persona** | Joe drops the jokes and points to 988 or 911 if the user talks about hurting themselves or being in danger. He's honest that he's an AI if sincerely asked. He nudges the user toward their real-life people. |

Rough costs, for a 30-minute call with caching on: Haiku under 1¢, Sonnet about 15¢, Opus about 30¢.

## Rule: keep Joe, Joe (and every friend themselves)

These rules started with Joe and now apply to every friend. Joe has to stay the same friend while he keeps learning about the user. Any change to this app has to keep these working:

1. **`contacts/joe/persona.md` is who Joe is.** Change his personality or family on purpose, never as a side effect of other work.
2. **The memory system stays.** That means `data/contacts/<id>/memory.json`, the Opus memory writer in `hangUp()`, and the memory section of the system prompt. Even if models, prompts or storage change, Joe must still read his notes at the start of each call and update them after it.
3. **Never wipe or reset `data/`.** If the memory format changes, convert the existing notes into the new format. Joe must not forget the user.
4. **Joe's made-up life details are part of memory.** The notes keep what he has said about Brandy, the kids and his life, so he stays consistent from call to call.
5. **Swapping the model or voice must not change who Joe is.** A new model or voice gets the same persona and the same notes.
6. **Test a real call after any change** to confirm Joe still sounds like Joe and remembers the last call.

## Still open (as of October 23, 2026)

- A full video call hasn't been tested with a live conversation yet. The video pieces were tested together: Chatterbox voice into Ditto face, inside the app.
- More friends: built. Add them with `/new-contact`.
- George Walker, Rosa's husband: built October 23, 2026, and linked to Rosa. Voice clips from movies and celebrity soundboards were turned down (real people who didn't agree). His voice is a CC0 narration by a Freesound voice actor.
- Rosa's voice was cloned from a singing clip. If it sounds off, replace it with a talking clip (`voice rosa <clip>`).
- Incoming calls: built. Each friend has a "calls you" setting (never / now and then / often). While the app is open and you're not on a call, they ring at random: about every 3 hours or every hour, never 9 PM to 8 AM, and not within 45 minutes of your last call. Answer, answer with video, or decline. Unanswered calls show as "Missed call" on the friends list. On an incoming call, the friend speaks first and says why they called. Rosa is set to "now and then". Friends can only call while the app window is open.

Done: Joe moved into `data/contacts/joe/` (backup in `data/backup-before-contacts/`). The app lives in `Documents\Call Joe`, with a **Call Joe** desktop shortcut. The first real calls worked on October 23, 2026, and Joe's memory notes saved correctly.
