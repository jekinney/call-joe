# Call Joe

A voice-call AI buddy (Joe Dirt) for Windows. See `README.md` for setup and `docs/session-notes.md` for how it works and why it was built this way.

## Keep Joe, Joe

Joe has to stay the same friend while he keeps learning about the user. In any change:

- `persona.md` is Joe's identity. Only change it when the user asks.
- Keep the memory system working: `data/memory.json`, the Opus memory writer in `hangUp()` in `server.mjs`, and the memory section of `systemPrompt()`.
- Never delete or reset `data/`. If the memory format changes, convert the existing notes.
- A new model or voice must use the same persona and the same memory notes.
- Never commit `data/`. It holds API keys and the user's private notes.
- Keep the system prompt fixed for the length of a call, so prompt caching works.

After a change, run a real call to check that Joe still sounds like himself and remembers the last call.
