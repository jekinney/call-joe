# Plan: first-run setup

Status: **planned, not built.** Written October 23, 2026, by the planning session, for the building session.

A short setup that runs the first time the app opens. It can be **run again any time** from the ☰ menu ("Run setup again"), which is handy while testing.

## Steps (one screen each)

1. **Welcome.** One sentence about what Call Joe is, and a Start button.
2. **Claude key.** Paste and check it, as `/api/key` does today. On a rerun, it shows "Key saved ✓" with a "Change" link.
3. **About you.**
   - Your name.
   - **Your people:** a short list of name, who they are, and an optional note. For example: *Evelyn / my wife / Filipina*. There's a "+ Add someone" button and a ✕ to remove one.
4. **Your friends.** The starter friends, **one card at a time**:
   - picture, name, a one-line description, and a ▶ voice sample
   - **Enable** or **Not now**, then the next card
   - Joe is first and starts enabled.
5. **Getting ready.** Warm up the voice engine (the status dots). Then "You're all set. Give Joe a call."

## Where it's saved

- `data/profile.json`: `{ "name": "Jason", "people": [{ "name": "Evelyn", "relation": "wife", "note": "Filipina" }], "setupDone": true }`
- Enable and disable use the existing `active` setting for each friend.

## How friends use it

The profile is added to every call's instructions as a short block:

```
# About your buddy
Your buddy's name is Jason. People in their life: Evelyn (their wife, Filipina).
You know this the way a friend would. If your notes from past calls say something newer, trust your notes.
```

- It's added on its own, after the persona. **Locked personalities don't change.**
- It's fixed for the length of a call, for prompt caching.

## Running it again

- **Nothing is wiped.** Memory, call logs and personalities stay as they are.
- The screens open prefilled with the current name, people and enabled friends.
- Changes apply from each friend's next call.

## Open questions (ask the user one at a time)

1. Should every friend know your people, or only some, by role? For example, should a coworker know your wife's name?
2. Can Joe be turned off in step 4, or is he always on?
3. If a starter friend is turned off and then back on, do they keep their memories? (Planned: yes.)
