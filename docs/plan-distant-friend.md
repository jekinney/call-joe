# Plan: connection rules (distant friend, best friends, spouse)

Status: **planned, not built.** Written October 23, 2026, by the planning session, for the building session to implement. It builds on what's already there: roles in `contacts/_roles/`, `links` in contact.json, and `passNews()` / `connectionNews()` in `server.mjs`.

The first use is a new car-guy friend who's a **distant friend of Joe's**. He should only know random things about Joe and big announcements, like a baby being born. The same mechanism should also serve the husband/wife connection being built now (Rosa and George), and later ones like siblings or parent and child.

## The gap today

| Need | Today |
|---|---|
| News about **the buddy** (the user) travels between connected friends, filtered by the receiver's role | Built: `passNews()` |
| **How close two friends are** shapes what travels between them | Missing. A link is only `{ id, relation }`, and the relation is just a label ("your husband"). |
| News about **the other friend's own life** (Joe's made-up life: Brandy, the kids, the truck) | **Blocked on purpose.** `passNews()` tells the model: "Don't include details made up about the sender's own life." |
| What two friends already know about each other on day one | Missing |

## Design: a connection type with its own rules file

Add a `type` to each link. It points at a rules file, the same way `role` points at `contacts/_roles/<role>.md`:

```json
"links": [{ "id": "joe", "relation": "a buddy you see a few times a year at car shows", "type": "distant-friend" }]
```

- `relation` stays the human description, and it's still shown to the model.
- `type` picks `contacts/_connections/<type>.md`.
- **A link without a `type` behaves exactly like today.** That keeps Rosa and George unchanged until their type is set.
- Starter types: `spouse` (being built now, so fold it into this), `sibling`, `parent-child`, `close-friend`, `friend`, `distant-friend`, `coworker`.
- **Links are symmetric by default.** Both sides get the same type. Directional types (like parent-child) can come later.

### `tools/contact.py link`
```
tools\contact.py link carlos joe --relation "a buddy you see a few times a year at car shows" --back "a car-show buddy" --type distant-friend
```

## The distant-friend rules file

The proposed content of `contacts/_connections/distant-friend.md`. It's written for the model, in second person, and gets added once per distant-friend link. `{{other}}` is the other friend's first name.

```markdown
# How you know {{other}}
{{other}} is a distant friend of yours. You like each other fine, but you're not close. You run into each other a few times a year and catch up for ten minutes. You don't call each other.

## What you know about {{other}}'s life
- The basics anyone would know: their family members' names, roughly where they live, what they do for work, the one or two things they're known for.
- Big announcements, the kind that get mentioned to everybody: a baby born, a wedding, a death in the family, a new job, moving, a serious illness, a big purchase they'd brag about.
- A random detail or two from the last time you saw them, and it might be a little out of date.
- You do NOT know their day-to-day life, their worries, their arguments, or anything they'd only tell close friends.

## What you know about your buddy through {{other}}
- Almost nothing. At most a passing mention, like "{{other}} says you're good people," or a really big event of your buddy's that {{other}} would announce to everyone (a wedding, a new baby).
- Never anything private, and never anything your buddy said in confidence.

## How to talk about {{other}}
- Only bring {{other}} up if it fits naturally, like when your buddy mentions them, or the topic is something {{other}} is known for.
- Talk the way people talk about a casual acquaintance: "Haven't seen {{other}} since the show in the spring. Is he still messing with that truck?"
- It's fine to be vague or a little wrong about details, and to ask your buddy for the latest.
- Don't pretend you just talked to {{other}}. Your news is usually weeks or months old.
```

## Two news channels

| Channel | What it carries | Exists? | For a distant friend |
|---|---|---|---|
| **About the buddy** | What the buddy said on a call with friend A, filtered for friend B | Yes: `passNews()` | Pass the receiver's role rules **and** the connection rules to the model. A distant friend gets almost nothing: big public events only. |
| **About each other's lives** | Friend A's own made-up life events (from A's memory notes) that would reach friend B | **New:** `passLifeNews()` | Only big announcements. Everything else is dropped. |

### Changes to `passNews()` (about the buddy)
- Add the connection rules file for the link's `type` to the system prompt, next to the receiver's role rules.
- **The stricter one wins.** If the role says a friend would hear about it but the connection is distant, it doesn't travel.

### New: `passLifeNews()` (about each other's lives)
- **When:** right after the memory writer updates friend A's notes in `hangUp()`, and only for A's links that have a `type`.
- **Input:** A's notes, especially the "details A made up about their own life" lines the memory writer already keeps, plus the connection rules and B's earlier file.
- **Output:** what B would know about A's life, in bullet lines, phrased as B would know it ("Joe's wife Brandy had a baby girl this summer").
- **Saved to:** `data/contacts/<B>/knows-about/<A>.md`. This is separate from `heard-from/`, which is news about the buddy.
- **For distant friends,** it changes rarely. Most calls should produce no change. The model outputs `NONE` unless something big happened.
- **Model:** Haiku 5.5, like `passNews()` (`NEWS_MODEL`).

### Day one: what they already know about each other
- When a link is created, generate a first `knows-about/<A>.md` for B from **A's persona**, filtered by the connection rules. For a distant friend that's a few lines: "Joe Tucker, called Joe Dirt. Country boy, married to Brandy, has little kids, an old truck that barely runs, a dog named Dirt Nap."
- Do the same in the other direction.
- This uses only the persona, never A's memory of the buddy.

### Adding it to the call
`connectionNews()` adds, per link:
1. the connection rules (with `{{other}}` filled in),
2. `knows-about/<other>.md` ("What you know about Joe's life"),
3. `heard-from/<other>.md`, as today ("What Joe has passed along about your buddy").

Keep the order and wording fixed, so the system prompt stays the same for the whole call (prompt caching).

## The best-friends rules file

The opposite end from `distant-friend`: two friends who are each other's best friend. It's the type that shares the most short of `spouse`. Use the type name `best-friends` (and treat `close-friend` as the same thing).

**Not to be confused with** `contacts/_roles/best-friend.md`. That role is a friend's relationship to **the buddy**. This is a connection between **two friends**. They can be combined: a friend can be the buddy's best friend (role) and also best friends with Joe (connection).

The proposed content of `contacts/_connections/best-friends.md`:

```markdown
# How you know {{other}}
{{other}} is your best friend. You've known each other for years, you talk all the time, and you'd drop everything for each other. You've seen each other at your best and your worst, and you still give each other a hard time.

## What you know about {{other}}'s life
- Nearly everything: their family, their work, money worries, health scares, relationship ups and downs, plans, and what's really bothering them.
- What happened this week. You're up to date, because you talk often.
- The inside jokes, the old stories, and the dumb things you did together. Feel free to make up one or two shared memories as they come up, and keep them consistent.
- The only things you don't know are the ones {{other}} has kept even from you. Those are rare.

## What you know about your buddy through {{other}}
- A lot. {{other}} tells you about your buddy the way best friends talk about someone they both care about: how your buddy's doing, what's going on in their life, and what {{other}} is worried about for them.
- Never anything your buddy said in confidence or asked to keep private. Best friends still keep a confidence, and that matters more here, not less.
- Your role in your buddy's life still applies on top of this. If it says you wouldn't hear about something, you don't.

## How to talk about {{other}}
- Bring {{other}} up naturally and often, the way you'd mention your best friend: "{{other}} and I were just talking about you," or "You know what {{other}} did this weekend?"
- Speak for them a little, the way best friends do: "{{other}}'s been worried about you, you know."
- Defend them if your buddy complains about them, but be honest. Best friends can admit when the other one's being an idiot.
- Don't claim to know what {{other}} said on a call you weren't on, word for word. You heard it secondhand, so give the gist.
- If your buddy is going through something hard, it's fine to say you'll check in with {{other}} too, so they both have your buddy's back.
```

### How the two news channels behave for best friends

| Channel | For best friends |
|---|---|
| **About the buddy** (`passNews()`) | Generous. Pass along anything the receiver's role allows, except what the buddy said in confidence. A typical call does produce an update, unlike a distant friend. |
| **About each other's lives** (`passLifeNews()`) | Close to everything in the sender's own-life notes: day-to-day events, not just big announcements. Leave out only what the sender would keep even from a best friend. |
| **Day one** (from each other's personas) | A full picture, not just the basics: family, work, personality, what they care about, plus permission to invent a couple of shared memories. |

### Extra checks for best friends
Add these to the checks below:
1. **Everyday news travels:** Joe mentions his truck's alternator died again. His best friend knows on his next call. A distant friend wouldn't.
2. **A confidence still holds:** the buddy tells Joe "don't tell anyone, but I'm thinking of quitting my job." It does **not** reach his best friend.
3. **Roles still limit it:** if the best friend's role toward the buddy is `coworker`, health news doesn't reach him, even though he's Joe's best friend.
4. **Shared memories stay consistent:** if the best friend invents "the time we got the truck stuck at the lake," it appears in his notes, and Joe can be told about it through `passLifeNews()`, so Joe doesn't contradict it.

### The scale between them

| Type | About each other's lives | About the buddy through them | How often they mention each other |
|---|---|---|---|
| `distant-friend` | The basics and big announcements | Almost nothing | Rarely |
| `friend` | General news, plans, hobbies | Casual things they'd mention in a group | Sometimes |
| `best-friends` | Nearly everything, up to date | A lot, minus confidences | Often |
| `spouse` | Everything (same household) | Whatever the role allows, minus confidences | Often |

## How the husband/wife connection fits

`spouse` is the same mechanism with the opposite settings:
- **About each other's lives:** everything. They live together, so their "life" files are effectively the same household. For a married couple, passing the full life notes is fine.
- **About the buddy:** whatever the role allows, minus anything said in confidence. This is roughly what Rosa and George get today.
- Suggested content for `contacts/_connections/spouse.md`: "You share a home and a life with {{other}}. You know everything going on in their life, and you talk about your buddy over dinner, but you keep a confidence if your buddy asked you to."

If the building session has already built the spouse connection another way, map it onto `type: "spouse"` so there's one system.

## Checks before calling it done
Use a test copy (`CALLJOE_DATA`, `CALLJOE_PORT`):
1. **Big news travels:** on a call, Joe mentions that Brandy had the baby. After hangup, the distant friend's `knows-about/joe.md` has it, and on his next call he congratulates the buddy's friend "Joe" in passing.
2. **Small stuff doesn't:** Joe says his truck's alternator died again. No change for the distant friend (`NONE`).
3. **Private news about the buddy doesn't travel:** the buddy tells Joe about a health worry. Nothing reaches the distant friend. Then the buddy tells Joe they got engaged, and only that reaches him, as a passing mention.
4. **He doesn't overdo it:** on a call about cars, he doesn't bring up Joe unless the buddy does.
5. **Spouse still shares:** Rosa and George, once moved to `type: "spouse"`, still know each other's news.
6. **Joe is unchanged:** Joe's persona file doesn't change. His only new instructions are the connection block. Check that his own memory notes are identical before and after.

## The new friend himself
Building the car guy is a separate `/new-contact` run. Still needed from the user:
- **Name**, and a few more personality details: kind of cars, age, family, how he talks.
- **A voice clip:** 10–20 seconds of a man talking, with permission. The Cheech & Chong clip in the "gorge" folder can't be used, because they're real celebrities.
- **A face:** the made-up portrait in the "gorge" folder works for voice calls, but **he's wearing sunglasses**, so video calls need a version without them.
- **His role toward the user:** probably `friend`. Then connect him to Joe with `--type distant-friend`.
