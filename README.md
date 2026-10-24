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

## First-time setup

A brand-new (or reset) phone walks you through setup: your name, whether you're a man or a woman, your town (for weather), your Anthropic API key if none is saved yet (with how to get one; you can skip it), which friends to install, and who each one is to you (best friend, close friend, family friend, sister, grandparent, neighbor and so on). Friends you skip can be installed later in Settings → Friends.

## Your API key and airplane mode

Your API key is never deleted by anything, not even Reset phone. **Airplane mode** (the ✈ tile when you pull down the status bar, or Settings → Account) turns the key off: no calls, friends don't call you, no news passes between friends, and live knowledge stops updating. Everything already saved stays on this computer. To remove the key for good, turn on airplane mode first, then Settings → Account → Remove key (two warnings).

## When friends are free

Every friend has a weekly routine (`availability.mjs`; `schedule` in their `data/contacts/<id>/contact.json`), drafted once by Claude from their persona: asleep, at work and what the job allows, lunch, school pickup, practices, church. It decides:

- **Calls:** asleep or at work, your call rings out, or they decline, and they text about it later ("sorry I missed you, was at work").
- **Text replies:** seconds in a live back-and-forth; otherwise a few minutes to an hour (now and then longer), slower when they're busy, and after they wake up if they're asleep. Waiting replies are kept in `pending.json` and arrive when they're due, or when you next open the app.
- **Reaching out:** they only call or text when they're free.

Your own hours (text Support `/quiet 10pm-7am`, `/work weekdays 9-5`; quiet defaults to 9 PM to 8 AM) keep friends from calling then. `data/activity.json` learns which hours you usually text and answer, so they reach out more then. When a friend mentions a lasting change to their routine ("I start night shifts"), their schedule updates and you get a notice.

## Support by text

**Support** sits at the top of Messages. Ask it anything, or use commands (`/help` lists them): `/Elena got divorced` (a life update: shown first, applied on `/yes`, the old persona archived and a dated note added so she knows it's recent), `/Elena show`, `/Elena schedule …`, `/Elena rule …`, `/Elena forget …`, `/Elena pause 3d` and `/Elena resume`, `/Elena calls daily`, `/Elena texts often`, `/Elena photo …`, `/rule …` for everyone (`data/rules.md`), `/rules`, `/me …`, `/quiet`, `/work`, `/who`, `/log` and `/undo` (`data/changes.json`).

In a friend's own conversation, a text starting with `/ai` tells them what to do, outside the conversation: `/ai send a pic of you at lunch`, `/ai text me a goodnight message`. They do it right away, in character and within their rules, without arguing or calling instead. The `/ai` text isn't shown or remembered; what they send is.

**Short videos.** Ask a friend for one ("send me a video of the kids at practice", or `/ai send me a video of your lunch`) and they send an 8 to 10 second vertical clip with sound, made by Google's Gemini Omni Flash from their album pictures and face (about $1 a video, with the Google AI key). Friends never send videos on their own. A frame from the middle is checked by Claude before it's sent. Videos are saved in `photos/videos/` (compressed to about 3 MB) and copied to the Desktop's `generated` folder.

**Google AI key (optional).** Settings → Account also takes a Google AI key (billing on). With it, friends' new photos are made by Google's Nano Banana. And if there's no Anthropic key, Gemini stands in for Claude (`gemini.mjs`): calls, texts, voicemails and memory all keep working, with the same personas and memory notes (Sonnet → Gemini 3.8 Flash, Haiku → 3.5 Flash-Lite, Opus → Gemini 4 Argon). Claude takes over again as soon as an Anthropic key is saved.

## The phone

Call Joe looks and works like an Android phone, inside a thin phone outline:
- **Silent mode** (🔕 tile in the pulled-down status bar, or Settings → Calls): calls and texts still come in and show on screen, without the ring or the ding. Incoming calls ring 7 times, then go to voicemail.
- **Status bar:** the time, and 🔔 notifications (new voicemails, missed calls, friends who need a voice clip). Click it to pull them down; × dismisses one, Clear all dismisses them all.
- **Home:** a clock, app icons (Phone, Contacts, Messages, Voicemail, Wallpaper, Settings, Tips, Support) and your favorite friends in the dock.
- **Tabs, always at the bottom:** Calls, Contacts, Messages and Settings.
  - **Calls:** Recents (the last 30 calls, ↙ incoming or ↗ outgoing, plus missed and declined) and Voicemail, with play buttons. A message's words stay hidden until you tap it or play it, and 🗑 deletes it (the missed call stays in Recents). **Clear** asks whether to clear all, incoming or outgoing calls. It only clears the list: friends still remember the calls, and voicemails stay.
  - **Contacts:** your active friends, the ＋ Add contact button, and friends you've turned off (with Turn on).
  - **Messages:** texting your friends is coming later.
  - **Settings:** a list of settings; ☰ jumps between them. You (name, man or woman, town), Friends (install, change relationships, delete), Calls (interrupt by talking), Looks, Account (your API key and airplane mode), System (reset phone) and About.
- **Navigation buttons:** ◁ back, ○ home, □ recent calls. Esc and a mouse's back button also go back.
- **Looks:** a wallpaper (presets, including softer ones like Blush, Lavender, Peach, Rose gold and Floral, or your own picture), the text color on it (picked separately for each wallpaper; Auto suits it), the phone outline color (black by default, or None), and the call screen style: Classic (the default) or Photo, where the friend's picture fills the screen.

## Each friend's settings (✎ Edit on their page)

- **Show on your contacts:** turn a friend off to hide them and stop their calls. Their memory is kept.
- **Flirting:** Off, Playful (a little teasing and charm) or Romantic (openly into you). Never explicit: Claude keeps it suggestive at most and fades to black in character. The **Romantic interest** relationship flirts romantically by default; a friendship can turn romantic and back.
- **Cussing:** let them swear the way they naturally would, or keep it clean (the default). It's also a checkbox when you install a friend; it starts checked for friends who swear by nature, like George.

- **Calls you:** how often this friend rings you while the app is open: never, rarely (every few days), about once a day, now and then (every few hours), often (about hourly) or constantly (a few times an hour). The "Try it" button makes them call in a few seconds.
- **Texts you:** how often they text you first: never, rarely, less than usual, their usual (depends on who they are to you), more, often or constantly.
- Both settings also go into the friend's instructions, so what they say about calling and texting matches.
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
- `index.html` — the phone: home screen, contacts, calls, settings and the call screen.
- `theme.js` — the looks: wallpapers, text colors and phone outlines.
- `voice/` — the Chatterbox installer and its local voice server.
- `video/` — the Ditto installer, the face server for video calls, and the speed-ups that make it fast enough to run live.
- `data/` — your API keys, each friend's memory notes and call logs (`data/contacts/<id>/`), voice samples and face pictures. Never committed.
- `docs/credits.md` — where each friend's voice clip and picture came from, and their licenses.
- `docs/building-a-contact.md` — how to add a friend, with Claude or by hand.
- `docs/plan-contacts.md` — the original plan for more friends.
- `docs/session-notes.md` — how Call Joe was built, the decisions behind it, and the rules for keeping every friend themselves as they learn.
