# Plan: more friends (contacts)

Status: **built** on October 23, 2026, with one change from the plan below. Friends are built one at a time with Claude (`/new-contact`, see `docs/building-a-contact.md`) instead of with an "Add a friend" form in the app. The user wanted to hand Claude a voice clip and a face picture and have it set everything up. Friends don't know about each other.

Written October 23, 2026.

## The goal

Joe is the first friend. Soon you'll be able to add more, each with their own personality, voice, face and memory of you. You'll pick who to call from a contacts screen, and choose a voice call or a video call.

## What each contact has

| Piece | Where it lives | In GitHub? |
|---|---|---|
| Name, photo or face, chosen model, voice service and voice, video on or off | `data/contacts/<id>/contact.json` | No |
| Personality and backstory | `contacts/<id>/persona.md` | Yes, like `persona.md` today |
| Memory notes about you | `data/contacts/<id>/memory.json` | No |
| Call transcripts | `data/contacts/<id>/call-log.txt` | No |
| Face picture for video calls | `data/contacts/<id>/face.png` | No |
| Voice sample for Chatterbox | `data/voices/` (shared, so one voice can be used by any contact) | No |

`<id>` is a short name like `joe` or `uncle-earl`.

API keys stay in `data/config.json`, shared by everyone.

## Moving Joe over (and keeping Joe, Joe)

The first step of this work moves Joe into the new layout without changing him:

1. `persona.md` moves to `contacts/joe/persona.md`, unchanged.
2. `data/memory.json` and `data/call-log.txt` move to `data/contacts/joe/`, unchanged.
3. Joe's current voice, model and face settings become `data/contacts/joe/contact.json`.
4. The move runs once, automatically, the first time the new version starts. It keeps a backup copy of the old files in `data/backup-before-contacts/`.
5. Afterward, a test call checks that Joe still sounds like Joe and remembers his last call.

The "keep Joe, Joe" rules in `docs/session-notes.md` apply to every contact. No friend's memory is ever reset or mixed with another's.

## Screens

1. **Contacts (the new home screen):** a list of friends with their picture, name and when you last talked. Each one has a **📞 Voice** button and a **🎥 Video** button.
2. **Call screen:** works like today, with the friend's face filling the window on a video call. You can switch between video and voice during a call.
3. **Add a friend:**
   - Type a name and a few sentences about who they are, like "my fishing buddy from Alabama, a retired mechanic, grumpy but kind."
   - Claude drafts the full personality file from that, and you can read and edit it before saving.
   - Pick a voice (record, upload or choose), and a face picture for video.
4. **Friend's settings:** edit their personality, voice, face and model, or delete the friend. Deleting asks you to confirm and keeps a backup of their memory.

## Server changes

- Every call request carries the contact's id. The system prompt is built from that contact's persona and memory.
- One call at a time. Starting a call with someone else ends the current one, and that friend's notes get saved first.
- Memory notes are written by Opus for every contact, the same as for Joe today.
- The video engine keeps one face loaded on the graphics card at a time. Switching friends loads the new face, which takes a few seconds.

## Build order

1. Move Joe into the contacts layout (described above) and test that he hasn't changed.
2. Contacts home screen, with Joe as the only contact.
3. "Add a friend," with a Claude-drafted personality.
4. Per-friend voice, face and model settings.
5. Update the docs and the `CLAUDE.md` rules so they cover every contact.

## Open questions for you

- **Should friends know about each other?** For example, could Joe mention "your buddy Earl"? The simplest choice is no: each friend only knows what you've told them. A shared "about me" page that every friend reads is an easy add-on.
- **Group calls**, with two friends on one call: possible later, but more complex. It isn't in this plan.
