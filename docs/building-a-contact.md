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

## Where a friend lives

| File | What it is | In GitHub? |
|---|---|---|
| `contacts/<id>/persona.md` | Who they are, plus the shared call rules | Yes |
| `data/contacts/<id>/contact.json` | Name and settings: brain (model), voice, face | No |
| `data/contacts/<id>/memory.json` | What they remember about you, written after each call | No |
| `data/contacts/<id>/call-log.txt` | Every call's transcript | No |
| `data/voices/<name>.wav` | The cleaned-up voice clip | No |
| `data/faces/<name>.png` | The cropped face picture | No |

## Tweaking a friend later

- **In the app:** open the friend and press ⚙ to change their brain (Haiku, Sonnet or Opus), voice, or face. You can also record or upload a new voice clip, or upload a new face, right there.
- **Personality:** ask Claude ("make Earl grumpier"), or edit `contacts/<id>/persona.md` and run `persona`.

## Rules that keep every friend themselves

These rules apply to every friend, not just Joe (also in `CLAUDE.md` and `docs/session-notes.md`):

- A friend's persona only changes when you ask.
- Their memory is never reset, edited or shared with another friend. Friends don't know about each other.
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
