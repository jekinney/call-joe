"""Builds and manages Call Joe friends ("contacts"). Run it with the video engine's Python:

    video\\.venv\\Scripts\\python.exe tools\\contact.py <command> ...

Commands:
    list                                  show every friend
    show <id>                             a friend's settings, files and memory size
    create <id> --name "Full Name" --persona draft.md --voice clip.mp3 [--voice-start SECONDS] [--model sonnet]
           [--role friend]
                                          make a new friend from a persona draft and a voice clip (every
                                          friend needs one); the shared phone-call rules in
                                          contacts/_call-rules.md are added to the end of the persona
    persona <id> draft.md                 replace a friend's persona (call rules added the same way)
    voice <id> clip.(mp3|m4a|wav|...) [--start SECONDS] [--name "Voice name"]
                                          give a friend a new voice clip: cleaned up to 20 s of mono WAV in
                                          data/voices, and cloned by Chatterbox on their calls
    face <id> picture.(jpg|png|...) [--name "Face name"]
                                          crop a picture around the face to a 540x720 portrait in
                                          data/faces, and set it as the friend's video face
    link <id> <other-id> --relation "your husband" --back "your wife" [--type married]
                                          connect two friends: each knows the other and hears news about you
                                          from the other's calls; --relation is what <other-id> is to <id>,
                                          --back is what <id> is to <other-id>. The relation words pick the
                                          connection rules in contacts/_connections/ (husband -> married,
                                          mother-in-law -> in-laws); --type picks one directly
    unlink <id> <other-id>                remove a link both ways
    role <id> <role>                      set the friend's role in your life, one of contacts/_roles/ (friend,
                                          best-friend, spouse, mom, dad, sister, brother, grandparent,
                                          coworker, neighbor); it decides what news reaches them from
                                          linked friends, and is added to their instructions
    knows <id> [--nfl-team MIN] [--home "Town, State"] [--web | --no-web] [--clear]
                                          live knowledge: an NFL team to follow (briefing plus lookups), a
                                          hometown for weather, and web search during calls
    reset <id>                            start a friend over: their memory, call log and news from linked
                                          friends move to data/contacts/<id>/archive/ (never deleted)
    activate <id> / deactivate <id>       show or hide a friend on the friends list (hidden friends never
                                          call you; nothing else about them changes)
    remove <id>                           archive a friend to data/removed/ (never deletes memory)
    cussing <id> on|off                   let the friend swear the way they naturally would, or keep it clean
                                          (the default); contacts/_language/ holds the instructions for each
    publish <id> --gender man|woman --about "One line" [--role-man ROLE] [--role-woman ROLE]
                                          make a friend installable from the app (Settings -> Friends, and
                                          first-time setup): copies their voice sample and face into
                                          contacts/<id>/ and writes contacts/<id>/friend.json with their
                                          defaults (model, live knowledge, links, and the relationship they
                                          start with for a man or a woman, and how often they call you).
                                          Run it after building a friend.

A friend's id is short and lowercase, like "joe" or "uncle-earl". Their memory and call logs are never
touched by this tool except "reset" and "remove", which move them to an archive folder.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("CALLJOE_DATA") or os.path.join(ROOT, "data")
PERSONAS = os.path.join(ROOT, "contacts")
CONTACTS = os.path.join(DATA, "contacts")
VOICES = os.path.join(DATA, "voices")
FACES = os.path.join(DATA, "faces")
CALL_RULES = os.path.join(PERSONAS, "_call-rules.md")
ROLES = os.path.join(PERSONAS, "_roles")
LANDMARKER = os.path.join(ROOT, "video", "checkpoints", "ditto_pytorch", "aux_models", "face_landmarker.task")
MODELS = ("haiku", "sonnet", "opus")
VOICE_SECONDS = 20  # Chatterbox needs about 10-20 seconds of clean speech


def fail(msg):
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


def file_name(name):
    """Same cleanup Joe's server uses for voice and face names."""
    return re.sub(r"[^\w\- ]", "", name).strip()[:40]


def check_id(cid):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", cid or ""):
        fail(f'"{cid}" isn\'t a valid id. Use lowercase letters, numbers and dashes, like "uncle-earl".')
    return cid


def read_json(path, default=None):
    try:
        with open(path, encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, value):
    with open(path, "w", encoding="utf8") as f:
        json.dump(value, f, indent=2)


def load(cid):
    info = read_json(os.path.join(CONTACTS, check_id(cid), "contact.json"))
    if info is None:
        fail(f'No friend with id "{cid}". Run "list" to see them.')
    return info


def save(cid, info):
    write_json(os.path.join(CONTACTS, cid, "contact.json"), info)


def first_name(info):
    return info["name"].split()[0]


def persona_text(draft_path, name):
    with open(draft_path, encoding="utf8") as f:
        draft = f.read().strip()
    if "## How you talk on the phone" in draft:
        return draft + "\n"  # already has the call rules (for example, a full persona copied from another friend)
    with open(CALL_RULES, encoding="utf8") as f:
        rules = f.read().replace("{{first}}", name.split()[0]).strip()
    return f"{draft}\n\n{rules}\n"


def ffmpeg():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return shutil.which("ffmpeg") or fail("ffmpeg isn't available. Run video\\setup-ditto.ps1 first.")


# ---------- commands ----------

def cmd_list(args):
    ids = sorted(d for d in os.listdir(CONTACTS) if os.path.isfile(os.path.join(CONTACTS, d, "contact.json"))) if os.path.isdir(CONTACTS) else []
    if not ids:
        print("No friends yet.")
    for cid in ids:
        info = load(cid)
        s = info.get("settings", {})
        mem = read_json(os.path.join(CONTACTS, cid, "memory.json"), {"calls": 0})
        voice = s.get("cbVoice") if s.get("cbVoice") and os.path.isfile(os.path.join(VOICES, f"{s['cbVoice']}.wav")) else "NEEDS A CLIP"
        links = ", ".join(f"{l['relation']}: {l['id']}" for l in info.get("links", []))
        knows = info.get("knows", {})
        knows = ", ".join(filter(None, [knows.get("nflTeam") and f"NFL {knows['nflTeam']}", knows.get("home"), knows.get("web") and "web"]))
        print(f"{cid:16s} {info['name']:24s} calls: {mem.get('calls', 0):<4} voice: {voice:20s} face: {s.get('face') or '-'}"
              + (f"  role: {info['role']}" if info.get("role") else "") + (f"  knows: {knows}" if knows else "")
              + (f"  linked ({links})" if links else "") + ("  [off]" if info.get("active") is False else ""))


def cmd_show(args):
    info = load(args.id)
    mem = read_json(os.path.join(CONTACTS, args.id, "memory.json"), {"notes": "", "calls": 0})
    print(json.dumps(info, indent=2))
    print(f"persona:  contacts/{args.id}/persona.md")
    print(f"memory:   {mem.get('calls', 0)} calls, {len(mem.get('notes', '').splitlines())} lines of notes")


def cmd_create(args):
    cid = check_id(args.id)
    if os.path.exists(os.path.join(CONTACTS, cid, "contact.json")) or os.path.exists(os.path.join(PERSONAS, cid, "persona.md")):
        fail(f'A friend with id "{cid}" already exists. Pick another id, or use "persona" to update them.')
    if args.model not in MODELS:
        fail(f"--model must be one of {', '.join(MODELS)}")
    # The voice clip is converted first, so a friend is never created without a working voice.
    if args.role:
        check_role(args.role)
    voice_name, seconds = make_voice(args.voice, args.voice_start, f"{args.name.strip()} voice")
    os.makedirs(os.path.join(PERSONAS, cid), exist_ok=True)
    with open(os.path.join(PERSONAS, cid, "persona.md"), "w", encoding="utf8") as f:
        f.write(persona_text(args.persona, args.name))
    os.makedirs(os.path.join(CONTACTS, cid), exist_ok=True)
    info = {"name": args.name.strip(), "created": datetime.datetime.now().isoformat(timespec="seconds"),
            "settings": {"model": args.model, "cbVoice": voice_name}}
    if args.role:
        info["role"] = args.role
    save(cid, info)
    print(f'Created {args.name} ("{cid}"). Persona: contacts/{cid}/persona.md')
    print(f'Voice "{voice_name}" saved ({seconds:.1f} s).' + (" Tip: a 10-20 second clip usually clones better." if seconds < 10 else ""))
    print("Next: add a face picture with \"face\" for video calls.")


def cmd_persona(args):
    info = load(args.id)
    with open(os.path.join(PERSONAS, args.id, "persona.md"), "w", encoding="utf8") as f:
        f.write(persona_text(args.draft, info["name"]))
    print(f"Updated contacts/{args.id}/persona.md. It takes effect on the next call.")


def make_voice(clip, start, voice_name):
    """Converts a clip into data/voices/<name>.wav for Chatterbox. Returns (name, seconds of speech)."""
    if not os.path.isfile(clip):
        fail(f"Can't find {clip}")
    name = file_name(voice_name)
    os.makedirs(VOICES, exist_ok=True)
    out = os.path.join(VOICES, f"{name}.wav")
    # Mono, 24 kHz, 16-bit; trimmed to 20 s; leading silence removed; loudness evened out.
    cmd = [ffmpeg(), "-y", "-loglevel", "error", "-ss", str(start), "-i", clip,
           "-af", "silenceremove=start_periods=1:start_threshold=-45dB,loudnorm=I=-18:TP=-2,"
                  f"atrim=0:{VOICE_SECONDS}",
           "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", out]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(out):
        fail(f"Couldn't convert the clip: {result.stderr.strip()}")
    import wave

    with wave.open(out) as w:
        seconds = w.getnframes() / w.getframerate()
    if seconds < 5:
        os.remove(out)
        fail(f"The clip only has {seconds:.1f} s of speech. Chatterbox needs at least 5 s (10-20 s is best).")
    return name, seconds


def cmd_voice(args):
    info = load(args.id)
    name, seconds = make_voice(args.clip, args.start, args.name or f"{info['name']} voice")
    settings = info.setdefault("settings", {})
    for old in ("engine", "voice", "rate", "elevenVoice"):  # settings from voice services that were removed
        settings.pop(old, None)
    settings["cbVoice"] = name
    save(args.id, info)
    print(f'Voice "{name}" saved ({seconds:.1f} s) and set for {info["name"]}.')
    if seconds < 10:
        print("Tip: a 10-20 second clip usually clones better.")


def find_face_box(rgb):
    """Returns (x0, y0, x1, y1) of the face's landmarks (brows to chin), or None."""
    if not os.path.isfile(LANDMARKER):
        return None
    import mediapipe as mp
    import numpy as np
    from mediapipe.tasks.python import BaseOptions, vision

    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=LANDMARKER), num_faces=2))
    found = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)).face_landmarks
    if not found:
        return None
    if len(found) > 1:
        print("Note: more than one face found; using the biggest one.")
    h, w = rgb.shape[:2]
    boxes = []
    for face in found:
        pts = np.array([[p.x * w, p.y * h] for p in face])
        boxes.append((*pts.min(0), *pts.max(0)))
    return max(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))


def cmd_face(args):
    import cv2
    import numpy as np

    info = load(args.id)
    if not os.path.isfile(args.picture):
        fail(f"Can't find {args.picture}")
    img = cv2.imdecode(np.fromfile(args.picture, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        fail("Couldn't read that picture. Try a JPG or PNG.")
    h, w = img.shape[:2]
    box = find_face_box(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    if box is None:
        print("Warning: no face found, so the picture was center-cropped. Video calls need a clear, front-facing face.")
        crop_h = min(h, w * 4 / 3)
        cx, cy = w / 2, h * 0.45
    else:
        x0, y0, x1, y1 = box
        # Head-and-shoulders framing: the brows-to-chin box is about 43% of the portrait's height, centered
        # 45% of the way down so there's room for hair or a hat. Same framing as Joe's picture.
        crop_h = min((y1 - y0) * 2.3, h, w * 4 / 3)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if (y1 - y0) < 120:
            print("Warning: the face is small in this picture, so the video may look blurry. A closer picture works better.")
    crop_w = crop_h * 3 / 4
    left = int(round(min(max(cx - crop_w / 2, 0), w - crop_w)))
    top = int(round(min(max(cy - crop_h * 0.45, 0), h - crop_h)))
    crop = img[top:top + int(crop_h), left:left + int(crop_w)]
    portrait = cv2.resize(crop, (540, 720), interpolation=cv2.INTER_AREA if crop_h > 720 else cv2.INTER_CUBIC)
    name = file_name(args.name or info["name"])
    os.makedirs(FACES, exist_ok=True)
    out = os.path.join(FACES, f"{name}.png")
    ok, png = cv2.imencode(".png", portrait)
    png.tofile(out)
    info.setdefault("settings", {})["face"] = name
    save(args.id, info)
    print(f'Face "{name}" saved to data/faces/{name}.png and set for {info["name"]}.')


def set_link(info, other_id, relation, kind=None):
    links = [l for l in info.get("links", []) if l["id"] != other_id]
    if relation:
        links.append({"id": other_id, "relation": relation, **({"type": kind} if kind else {})})
    if links:
        info["links"] = links
    else:
        info.pop("links", None)


def cmd_link(args):
    if args.id == args.other:
        fail("A friend can't be linked to themselves.")
    a, b = load(args.id), load(args.other)
    if args.type and not os.path.isfile(os.path.join(PERSONAS, "_connections", f"{args.type}.md")):
        kinds = sorted(f[:-3] for f in os.listdir(os.path.join(PERSONAS, "_connections")) if f.endswith(".md"))
        fail(f'"{args.type}" is not a connection type. Pick one of: {", ".join(kinds)}.')
    set_link(a, args.other, args.relation.strip(), args.type)
    set_link(b, args.id, args.back.strip(), args.type)
    save(args.id, a)
    save(args.other, b)
    print(f'Linked: {b["name"]} is {args.relation.strip()} to {a["name"]}, and {a["name"]} is {args.back.strip()} to {b["name"]}.')
    print("From their next calls on, each one hears what you told the other.")


def cmd_unlink(args):
    a, b = load(args.id), load(args.other)
    set_link(a, args.other, None)
    set_link(b, args.id, None)
    save(args.id, a)
    save(args.other, b)
    print(f'Unlinked {a["name"]} and {b["name"]}. Their memories stay as they are.')


def cmd_active(args):
    info = load(args.id)
    if args.on:
        info.pop("active", None)  # active is the default
    else:
        info["active"] = False
    save(args.id, info)
    print(f'{info["name"]} is now {"active" if args.on else "off (hidden from the friends list)"}.')


def roles():
    return sorted(f[:-3] for f in os.listdir(ROLES) if f.endswith(".md")) if os.path.isdir(ROLES) else []


def check_role(role):
    if role not in roles():
        fail(f'"{role}" isn\'t a role. Pick one of: {", ".join(roles())} (or add contacts/_roles/{role}.md).')


def cmd_role(args):
    info = load(args.id)
    check_role(args.role)
    info["role"] = args.role
    save(args.id, info)
    print(f'{info["name"]} is now your {args.role.replace("-", " ")}. It takes effect on their next call.')


def cmd_knows(args):
    info = load(args.id)
    k = {} if args.clear else dict(info.get("knows", {}))
    if args.nfl_team:
        k["nflTeam"] = args.nfl_team.upper()
    if args.home:
        k["home"] = args.home.strip()
    if args.web is not None:
        k["web"] = args.web
    k = {key: v for key, v in k.items() if v}
    if k:
        info["knows"] = k
    else:
        info.pop("knows", None)
    save(args.id, info)
    print(f'{info["name"]} knows: {json.dumps(k) if k else "nothing live (no briefing or lookups)"}.')


def cmd_reset(args):
    info = load(args.id)
    folder = os.path.join(CONTACTS, args.id)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    archive = os.path.join(folder, "archive", stamp)
    moved = []
    for name in ("memory.json", "call-log.txt", "heard-from"):
        src = os.path.join(folder, name)
        if os.path.exists(src):
            os.makedirs(archive, exist_ok=True)
            shutil.move(src, os.path.join(archive, name))
            moved.append(name)
    if moved:
        print(f'{info["name"]} starts over. Archived {", ".join(moved)} to data/contacts/{args.id}/archive/{stamp}/.')
    else:
        print(f'{info["name"]} had no memory yet; nothing to archive.')


def cmd_remove(args):
    info = load(args.id)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    archive = os.path.join(DATA, "removed", f"{args.id}-{stamp}")
    os.makedirs(archive)
    shutil.move(os.path.join(CONTACTS, args.id), os.path.join(archive, "data"))
    persona_dir = os.path.join(PERSONAS, args.id)
    if os.path.isdir(persona_dir):
        shutil.move(persona_dir, os.path.join(archive, "persona"))
    print(f'{info["name"]} archived to data/removed/{args.id}-{stamp} (memory and call logs kept there).')


def cmd_cussing(args):
    info = load(args.id)
    if args.state == "on":
        info["cussing"] = True
    else:
        info.pop("cussing", None)
    save(args.id, info)
    print(f'{info["name"]} {"can cuss" if args.state == "on" else "keeps it clean"} from their next call or text.')


def cmd_publish(args):
    info = load(args.id)
    for role in (args.role_man, args.role_woman):
        check_role(role)
    s = info.get("settings", {})
    folder = os.path.join(PERSONAS, args.id)
    voice = os.path.join(VOICES, f"{s.get('cbVoice', '')}.wav")
    if not s.get("cbVoice") or not os.path.isfile(voice):
        fail(f'{info["name"]} has no voice clip yet; add one with "voice" first.')
    shutil.copyfile(voice, os.path.join(folder, "voice.wav"))
    face = os.path.join(FACES, f"{s.get('face', '')}.png")
    has_face = bool(s.get("face")) and os.path.isfile(face)
    if has_face:
        shutil.copyfile(face, os.path.join(folder, "face.png"))
    friend = {
        "name": info["name"],
        "gender": args.gender,
        "about": args.about.strip(),
        "model": s.get("model", "sonnet"),
        **({"callsYou": s["callsYou"]} if s.get("callsYou") and s["callsYou"] != "never" else {}),
        **({"cussing": True} if info.get("cussing") else {}),
        "roles": {"man": args.role_man, "woman": args.role_woman},
        **({"knows": info["knows"]} if info.get("knows") else {}),
        **({"links": info["links"]} if info.get("links") else {}),
    }
    write_json(os.path.join(folder, "friend.json"), friend)
    print(f'{info["name"]} can now be installed from the app. Saved contacts/{args.id}/friend.json, voice.wav'
          + (" and face.png." if has_face else " (no face picture yet)."))


def main():
    p = argparse.ArgumentParser(description="Build and manage Call Joe friends.", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    s = sub.add_parser("show"); s.add_argument("id"); s.set_defaults(fn=cmd_show)
    s = sub.add_parser("create"); s.add_argument("id"); s.add_argument("--name", required=True)
    s.add_argument("--persona", required=True); s.add_argument("--voice", required=True, help="voice clip to clone")
    s.add_argument("--voice-start", type=float, default=0); s.add_argument("--model", default="sonnet")
    s.add_argument("--role"); s.set_defaults(fn=cmd_create)
    s = sub.add_parser("persona"); s.add_argument("id"); s.add_argument("draft"); s.set_defaults(fn=cmd_persona)
    s = sub.add_parser("voice"); s.add_argument("id"); s.add_argument("clip"); s.add_argument("--start", type=float, default=0)
    s.add_argument("--name"); s.set_defaults(fn=cmd_voice)
    s = sub.add_parser("face"); s.add_argument("id"); s.add_argument("picture"); s.add_argument("--name"); s.set_defaults(fn=cmd_face)
    s = sub.add_parser("link"); s.add_argument("id"); s.add_argument("other")
    s.add_argument("--relation", required=True, help='what <other> is to <id>, like "your husband"')
    s.add_argument("--back", required=True, help='what <id> is to <other>, like "your wife"')
    s.add_argument("--type", help="connection rules to use (a file in contacts/_connections/); normally picked from the relation words")
    s.set_defaults(fn=cmd_link)
    s = sub.add_parser("unlink"); s.add_argument("id"); s.add_argument("other"); s.set_defaults(fn=cmd_unlink)
    s = sub.add_parser("role"); s.add_argument("id"); s.add_argument("role"); s.set_defaults(fn=cmd_role)
    s = sub.add_parser("knows"); s.add_argument("id"); s.add_argument("--nfl-team"); s.add_argument("--home")
    s.add_argument("--web", action="store_true", default=None); s.add_argument("--no-web", dest="web", action="store_false")
    s.add_argument("--clear", action="store_true"); s.set_defaults(fn=cmd_knows)
    s = sub.add_parser("reset"); s.add_argument("id"); s.set_defaults(fn=cmd_reset)
    s = sub.add_parser("activate"); s.add_argument("id"); s.set_defaults(fn=cmd_active, on=True)
    s = sub.add_parser("deactivate"); s.add_argument("id"); s.set_defaults(fn=cmd_active, on=False)
    s = sub.add_parser("remove"); s.add_argument("id"); s.set_defaults(fn=cmd_remove)
    s = sub.add_parser("cussing"); s.add_argument("id"); s.add_argument("state", choices=["on", "off"]); s.set_defaults(fn=cmd_cussing)
    s = sub.add_parser("publish"); s.add_argument("id"); s.add_argument("--gender", choices=["man", "woman"], required=True)
    s.add_argument("--about", required=True); s.add_argument("--role-man", default="friend")
    s.add_argument("--role-woman", default="friend"); s.set_defaults(fn=cmd_publish)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
