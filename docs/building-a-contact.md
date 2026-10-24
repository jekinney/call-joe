# Building a new friend

Each friend in Call Joe has their own personality, voice, face and memory of you. You build them one at a time, either with Claude (easiest) or by hand with the builder tool.

## What you need

| Piece | What works best | Required? |
|---|---|---|
| **A name** | A full name, like "Earl Hollis". They'll go by their first name. | Yes |
| **Who they are** | A few sentences: personality, age, where they're from, job, family, how they talk, how they know you. | Yes |
| **A voice clip** | 10–20 seconds of one person talking clearly, with no music or other voices, in the accent you want. Any audio format (mp3, m4a, wav, a phone voice memo). | **Yes.** Every friend's voice is cloned from a clip. A friend can't be created or called without one. |
| **A face picture** | One front-facing face, mouth closed, soft even light, plain background. A head-and-shoulders portrait is ideal. Any size; the tool crops it. | No. Without one, they're voice calls only. |

**Permission matters:**
- Only clone a voice you're allowed to: your own, someone who agreed, or a clip licensed for cloning. Never a celebrity, or a real person who hasn't agreed.
- For faces, use a made-up face (an AI-generated portrait is perfect), or a real person only with their consent.

## The easy way: with Claude

1. Open Claude Code in the `Call Joe` folder.
2. Type `/new-contact`.
3. Tell Claude about the friend. Then add the voice clip and the picture: drag the files into the prompt (or type their paths), or paste the picture.
4. Claude asks a couple of questions, writes the personality, and shows it to you. Ask for any changes until it sounds right.
5. Claude sets up the voice and face, shows you the cropped picture, and tells you when the friend is ready.

The friend then shows up on the **Friends** screen in the app. If the app is open, go back to Friends or reload it.

## By hand: the builder tool

Run these from the `Call Joe` folder:

```
video\.venv\Scripts\python.exe tools\contact.py create earl --name "Earl Hollis" --persona earl.md --voice "C:\path\to\earl-voice.m4a"
video\.venv\Scripts\python.exe tools\contact.py face earl "C:\path\to\earl.jpg"
video\.venv\Scripts\python.exe tools\contact.py list
```

- **`earl.md`** is the personality, written in second person ("You're Earl..."). Use `contacts/joe/persona.md` as a model. Leave out the phone and safety rules: `create` adds `contacts/_call-rules.md` automatically, which covers talking naturally on a call, being honest about being an AI, crisis help (988/911), and nudging you toward real-life people.
- **`--voice`** (required) is the voice clip. The tool trims leading silence, evens out the volume, and keeps the first 20 seconds as clean mono audio for Chatterbox. If the clip starts with an intro, skip it with `--voice-start 3`. A clip with under 5 seconds of speech is refused, and the friend isn't created.
- **`voice <id> <clip>`** gives an existing friend a new voice clip later (with `--start 3` to skip an intro).
- **`face`** finds the face and crops a 540×720 head-and-shoulders portrait around it. If it can't find a face, it center-crops and warns you. Look at the result in `data/faces/` either way.
- **Other commands:**
  - `show <id>` prints a friend's settings.
  - `persona <id> <file>` replaces their personality. It takes effect on the next call, and their memory is kept.
  - `remove <id>` archives the friend to `data/removed/`. Nothing is deleted.

## Linking friends (like a married couple)

Friends normally don't know about each other. Two friends who belong together, like spouses, can be linked:

```
video\.venv\Scripts\python.exe tools\contact.py link rosa george --relation "your husband" --back "your wife"
```

- `--relation` is what the second friend is to the first ("George is your husband"). `--back` is the reverse ("Rosa is your wife").
- The relation words pick the **connection rules** from `contacts/_connections/`: married, parent-child, in-laws, siblings, grandparent, friends, coworkers or neighbors. Similar relationships share one ("mother-in-law" and "son-in-law" both use in-laws). Add `--type <name>` to pick one directly, or add a new file for a new kind of relationship.
- After each call, news about you travels to the connected friend, filtered by **their role in your life** (see below) and how they're connected. It's saved as what they've "heard" (`data/contacts/<id>/heard-from/`), never as the other friend's raw notes. Anything you ask to keep private stays private.
- `unlink rosa george` removes the link both ways. Their own memories stay as they are.
- Their personas should also mention each other (for example, Rosa's says George is her husband), so they can talk about each other even before you've called both.

## A friend's role in your life

In the app: Settings → Friends, the menu under each friend. From the command line, `tools\contact.py role <id> <role>` sets who they are to you: best-friend, close-friend, friend, family-friend, neighbor, coworker, mom, dad, sister, brother, grandparent, aunt, uncle, cousin or spouse. When you and a friend are both women, best-friend becomes `girlfriend-bestie` automatically. Each role has a rules file in `contacts/_roles/` (what they'd plausibly hear about you, and what they wouldn't), and it's added to their instructions. Edit those files to fit your family, or add a new role file.

## What they keep up with (live knowledge)

`tools\contact.py knows <id> --nfl-team MIN --home "Bloomington, Minnesota" --web`
- `--nfl-team`: real scores, schedule, standings and headlines from ESPN, in a briefing at the start of each call, plus lookups during it.
- `--home`: the real weather where they live, plus weather lookups anywhere.
- `--web`: web search during calls, for recipes, prices and anything else.
- `--clear` removes everything. Details are in `docs/roadmap.md`, section 5.

## Starting a friend over

`tools\contact.py reset <id>` archives their memory, call log and news from other friends to `data/contacts/<id>/archive/`, so the next call is a fresh start. Nothing is deleted. Their personality, voice, face and settings stay.

## Where a friend lives

| File | What it is | In GitHub? |
|---|---|---|
| `contacts/<id>/persona.md` | Who they are, plus the shared call rules | Yes |
| `data/contacts/<id>/contact.json` | Name, settings (brain, voice, face) and links to other friends | No |
| `data/contacts/<id>/memory.json` | What they remember about you, written after each call | No |
| `data/contacts/<id>/call-log.txt` | Every call's transcript | No |
| `data/voices/<name>.wav` | The cleaned-up voice clip | No |
| `data/faces/<name>.png` | The cropped face picture | No |

## Turning friends on and off

Contacts → the friend → ✎ Edit → **Show on your contacts**.
- Only active friends show on your contacts, and only active friends call you.
- Turning a friend off only hides them. Their personality, voice, face, memory and links stay exactly as they are, but they hear no news about you from linked friends while they're off.
- Turn them back on any time. They catch up on the news they missed from linked friends' calls.
- From the command line: `tools\contact.py deactivate <id>` and `activate <id>`. In `list`, friends who are off show `[off]`.

## Cussing

Off by default: friends keep it clean (`contacts/_language/clean.md`). Allowed, they swear the way they naturally would (`contacts/_language/cussing.md`). Set it with the checkbox when installing, the Cussing switch in the friend's ✎ Edit, or `tools\contact.py cussing <id> on|off`. `publish` saves it as the friend's default, so the install checkbox starts checked.

## Friend kits (rebuild a friend from a folder)

A friend kit is a folder anywhere (like the Desktop) with a `friend-kit.json` and the files it names:

```json
{ "id": "earl", "name": "Earl Hollis", "persona": "persona.md", "voice": "clip.mp3", "face": "face.jpg",
  "gender": "man", "about": "One line about them", "role": "friend", "roles": { "man": "friend", "woman": "friend" },
  "knows": { "home": "Town, State", "web": true }, "cussing": false, "flirting": "off", "callsYou": "never", "private": false }
```

`tools\contact.py import <folder>` builds the friend from it (voice, face, settings, and installable afterwards). `"private": true` keeps the friend out of git with a rule in `.git/info/exclude`, which lives on this computer only, so the repo never mentions them. A `.cmd` file in the kit folder that runs the import makes it a double-click.

## Installing, deleting and resetting

- Friends with a `contacts/<id>/friend.json` (made by `tools\contact.py publish`) can be installed in first-time setup or in Settings → Friends, with a relationship you pick.
- **Delete** (Settings → Friends) removes a friend for good: memory, call log, voicemail and news. Two warnings come first, and the second asks you to type their first name. They go back to "Ready to install", brand new.
- **Reset phone** (Settings → System) wipes everything in `data/` except your API key, logs and the weather and sports cache, then opens first-time setup. Two warnings first; the second asks you to type RESET.

## Tweaking a friend later

- **In the app:** open the friend and press ⚙ to change their brain (Haiku, Sonnet or Opus), voice, or face. You can also record or upload a new voice clip, or upload a new face, right there.
- **Personality:** ask Claude ("make Earl grumpier"), or edit `contacts/<id>/persona.md` and run `persona`.

## Rules that keep every friend themselves

These rules apply to every friend, not just Joe (also in `CLAUDE.md` and `docs/session-notes.md`):

- A friend's persona only changes when you ask.
- Their memory is never reset or edited. It's only shared with a friend they're linked to (like a spouse). Otherwise, friends don't know about each other.
- Changing their model, voice or face doesn't change who they are.
- After a change, a test call should show they still sound like themselves and remember your last call.

## Tips for good results

- **Voice:**
  - Record in a quiet room, phone about a foot away, talking naturally for 15 seconds.
  - Read the sample script in the app's Chatterbox settings, in the accent you want.
  - Background music or a second voice makes the clone wobbly.
- **Face:**
  - Ask an image tool for "photo, head-and-shoulders portrait, looking straight at the camera, neutral expression, mouth closed, soft lighting, plain background".
  - Avoid sunglasses, hands near the face, and strong side lighting.
