# Call Joe

Voice and video calls with AI friends (contacts) on Windows. Joe Tucker (nicknamed "Joe Dirt") was the first friend. See `README.md` for setup, `docs/session-notes.md` for how it works and why, and `docs/building-a-contact.md` for adding a friend.

## Adding a friend

The user builds friends one at a time with Claude, using the `/new-contact` skill (`.claude/skills/new-contact/SKILL.md`) and `tools/contact.py`. Follow that skill: it covers the permission checks for voice clips and face pictures.

## Keep every friend themselves

Each friend has to stay the same while they keep learning about the user. In any change:

- `contacts/<id>/persona.md` is a friend's identity. Only change it when the user asks.
- Keep the memory system working: `data/contacts/<id>/memory.json`, the Opus memory writer in `hangUp()` in `server.mjs`, and the memory section of `systemPrompt()`.
- Never delete, reset or mix up memory in `data/contacts/` yourself. The user can delete a friend (Settings → Friends → Delete) or reset the whole phone (Settings → System) in the app, each behind two warnings; that's the only way memory is deleted. Friends don't know about each other, unless they're linked (`tools/contact.py link`, for a couple like Rosa and George). Linked friends never see each other's notes. They only get filtered news (`passNews()` in `server.mjs`, saved in `data/contacts/<id>/heard-from/`), decided by the receiver's role in `contacts/_roles/`. `tools/contact.py reset` (archive and start over) is only for when the user asks. If the memory format changes, convert the existing notes. To retire a friend, use `tools/contact.py remove`, which archives them.
- A new model or voice must use the same persona and the same memory notes.
- Every friend's voice is cloned by Chatterbox from a voice clip (`cbVoice`). There are no other voice services, and a friend never exists without a voice.
- Never delete the user's API key (`data/config.json` `apiKey`), in any reset, cleanup or migration. Only the user removes it (Settings → Account → Remove key), and only after turning on airplane mode.
- Never commit `data/`. It holds API keys, the user's private notes, voice samples and face pictures.
- Keep the system prompt fixed for the length of a call, so prompt caching works.
- `video/ditto/` is Ditto's code, cloned by `video/setup-ditto.ps1`. Don't edit it directly. Put changes in `video/fast_ditto.py`, or in `video/patches/` with a copy step in the setup script.

After a change, run a real call to check the friend still sounds like themselves and remembers the last call. To test without touching the user's data, run a copy with `CALLJOE_DATA=<test folder>` and `CALLJOE_PORT=<other port>`.
