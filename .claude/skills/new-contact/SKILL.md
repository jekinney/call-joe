---
name: new-contact
description: Build a new Call Joe friend (contact) with the user, one at a time. They give a name, a few sentences about who the friend is, a short voice clip to clone and a face picture for video calls; this writes the persona and sets up the voice and face with tools/contact.py. Use when the user types /new-contact or asks to add, build or make a new friend or contact.
---

# Build a new friend

You're helping the user add one new friend to Call Joe. Work through these steps in order and keep it conversational. Full background is in `docs/building-a-contact.md`.

Run the tool with the video engine's Python, from the project folder:

```
video\.venv\Scripts\python.exe tools\contact.py <command> ...
```

## 1. Gather what you need

Ask for anything the user hasn't already given:

- **Name.** A full name like "Earl Hollis". Their first name is how they introduce themselves.
- **Who they are.** A few sentences: personality, age, where they're from, job, family, how they talk, and how they know the user, if that matters.
- **Voice clip (required).** A file path to 10–20 seconds of one person talking clearly, with no music. Audio can't be pasted into the chat, so the user drags the file into the prompt or types its path. Most formats work (mp3, m4a, wav, ogg, a phone voice memo).
- **Face picture.** A path or a pasted image. It should be one front-facing face, mouth closed, with plain light and background. A pasted image comes with a file path you can use.

Every friend needs a voice clip: there's no other voice, and a friend can't be created without one. The face can come later; without one, the friend has voice calls only.

## 2. Check permission (always, briefly)

- **Voice:** only clone a voice the user has permission to use: their own, someone who agreed, or a clip licensed for cloning. Don't clone a celebrity, a public figure, or a real person who hasn't agreed. If it's unclear, ask once.
- **Face:** use a made-up face (an AI-generated portrait is fine), or the user's own or a consenting person's. Don't use a photo of a real person without their consent, or a celebrity.

If the face check fails, say so plainly and continue without a face. If the voice check fails, the friend can't be built until there's a clip that passes, so ask for another one.

## 3. Interview, briefly

Ask two or three short questions to fill gaps, not a questionnaire. For example:

- What's the funniest or most them thing about this friend?
- Who's in their life? Spouse, kids, pets, coworkers.
- Is there anything they should never joke about, or something they care about deeply?

## 4. Write the persona and get approval

Write the persona as Markdown in second person ("You're Earl..."), in the same style as `contacts/joe/persona.md`, using these sections:

- `# Who you are`: one or two lines setting up the phone call with their buddy.
- `## <First name>`: personality, how they talk (a few signature phrases, without overdoing it), what they care about, and how they act when the buddy is struggling.
- `## <First name>'s life`: family, home, work, pets, a few concrete everyday details to draw on, and an instruction to make up small details as they come up and stay consistent.

**Don't include phone or safety rules.** The tool adds `contacts/_call-rules.md` automatically: natural phone talk, being honest about being an AI, crisis help (988/911), and nudging toward real-life people.

Show the user the draft and revise it until they approve. Keep it to about 250–450 words.

## 5. Create the friend

1. Pick an id: lowercase with dashes, like `earl` or `uncle-earl`. Check `list` so it isn't taken.
2. Save the approved draft to a file in your scratchpad folder, not in the project.
3. Run each command:
   ```
   video\.venv\Scripts\python.exe tools\contact.py create <id> --name "<Full Name>" --persona <draft file> --voice "<clip path>"
   video\.venv\Scripts\python.exe tools\contact.py face <id> "<picture path>"
   ```
   - `create` takes `--voice-start <seconds>` to skip an intro or music at the start of the clip. A clip with under 5 seconds of speech is refused and nothing is created; ask for a longer clip.
   - The default brain is Sonnet. Add `--model haiku` or `--model opus` to `create` if the user asks.

## 6. Check the result

- Open `data/faces/<name>.png` with the Read tool and look at the crop. It should be head and shoulders, with the face centered and not cut off. If the crop is bad or the tool warned that no face was found, tell the user and ask for a better picture.
- If the tool said the voice clip was short (under 10 seconds), suggest a longer one.
- Run `list` and show the user the new friend.
- If the voice clip or picture came from somewhere that requires credit (like a Creative Commons Attribution clip), add it to `docs/credits.md`.

## 7. Wrap up

Tell the user:

- The friend shows up on the Friends screen. If the app is open, go back to Friends or reload it.
- Voice and video settings can be tweaked later in that friend's ⚙ settings in the app.
- The first call is a fresh start: the friend will ask the user's name and get to know them.

Then ask whether to save the new friend's persona to GitHub. If yes, commit only `contacts/<id>/persona.md`. Never commit `data/`, which holds the voice clip, face picture and memory.

## Rules that always apply

- One friend at a time.
- Never edit another friend's persona or anything in `data/contacts/` (memory and call logs) while building a new one.
- To change an existing friend's personality, use `tools\contact.py persona <id> <file>`, but only when the user asks. It takes effect on their next call, and their memory is kept.
