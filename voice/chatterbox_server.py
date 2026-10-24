"""Local Chatterbox voice server for Joe. Joe's Node server starts it and sends it text to speak.

POST /tts  {"text": ..., "voice_path": ...}  ->  audio/wav
POST /warm                                                          ->  starts loading the multilingual model
GET  /health                                                        ->  {"ready": true, ...}

Words a friend says in another language come wrapped in tags, like "<es>¡Ay, Dios mío!</es>". A sentence with
tags is spoken by Chatterbox's multilingual model, each piece in its own language, in the same cloned voice, so
the Spanish has a real accent. Sentences without tags use the faster English model.
"""
import io
import json
import re
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5175

state = {"ready": False, "error": None, "device": None, "model": None, "multilingual": "off"}
model = None
mtl_model = None
gpu_lock = threading.Lock()  # one GPU, so one sentence at a time
mtl_lock = threading.Lock()  # load the multilingual model only once
current_voice = {"key": None}
mtl_voice = {"key": None}
LANG_TAG = re.compile(r"<(/?)([a-z]{2})>")
GAP_SECONDS = 0.06  # pause between an English piece and a Spanish piece of the same sentence


def load_model():
    global model
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        try:
            from chatterbox.tts_turbo import ChatterboxTurboTTS

            model = ChatterboxTurboTTS.from_pretrained(device)
            state["model"] = "turbo"
        except ImportError:
            from chatterbox.tts import ChatterboxTTS

            model = ChatterboxTTS.from_pretrained(device)
            state["model"] = "standard"
        state["device"] = device
        state["ready"] = True
        print(f"Chatterbox ready ({state['model']} on {device})", flush=True)
    except Exception as exc:  # report it to the app instead of dying silently
        state["error"] = f"{type(exc).__name__}: {exc}"
        print("Chatterbox failed to load:", state["error"], flush=True)


def load_multilingual():
    """Loads the multilingual model (about 3.5 GB of graphics memory) the first time a friend needs it."""
    global mtl_model
    with mtl_lock:
        if mtl_model is not None:
            return mtl_model
        state["multilingual"] = "loading"
        try:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            mtl_model = ChatterboxMultilingualTTS.from_pretrained("cuda" if torch.cuda.is_available() else "cpu")
            state["multilingual"] = "ready"
            print("Chatterbox multilingual ready", flush=True)
        except Exception as exc:
            state["multilingual"] = f"failed: {type(exc).__name__}: {exc}"
            print("Chatterbox multilingual failed to load:", state["multilingual"], flush=True)
        return mtl_model


def segments(text):
    """Splits a sentence into (language, words) pieces. The page cuts replies into sentences, so a tag can be
    left open at the end of one sentence or closed at the start of the next; both still work."""
    tags = list(LANG_TAG.finditer(text))
    lang = tags[0].group(2) if tags and tags[0].group(1) else "en"  # starts inside a tag opened last sentence
    pieces, at = [], 0
    for tag in tags:
        pieces.append((lang, text[at:tag.start()]))
        lang = "en" if tag.group(1) else tag.group(2)
        at = tag.end()
    pieces.append((lang, text[at:]))
    out = []
    for lang, words in pieces:
        words = words.strip()
        if not words:
            continue
        if not re.search(r"\w", words) and out:  # stray punctuation belongs to the piece before it
            out[-1] = (out[-1][0], out[-1][1] + words)
        elif out and out[-1][0] == lang:
            out[-1] = (lang, out[-1][1] + " " + words)
        else:
            out.append((lang, words))
    return out


def synthesize(text, voice_path):
    pieces = segments(text)
    multilingual = any(lang != "en" for lang, _ in pieces) and load_multilingual() is not None
    with gpu_lock:
        if multilingual:
            from chatterbox.mtl_tts import SUPPORTED_LANGUAGES

            if mtl_voice["key"] != voice_path:
                mtl_model.prepare_conditionals(voice_path)
                mtl_voice["key"] = voice_path
            gap = np.zeros(int(mtl_model.sr * GAP_SECONDS), dtype=np.float32)
            parts = []
            for lang, words in pieces:
                wav = mtl_model.generate(words, language_id=lang if lang in SUPPORTED_LANGUAGES else "en")
                parts += [wav.squeeze().detach().cpu().numpy().astype(np.float32), gap]
            samples, sr = np.concatenate(parts[:-1]), mtl_model.sr
        else:
            # Reuse the voice's conditioning between sentences instead of re-reading the clip each time.
            if current_voice["key"] != voice_path:
                model.prepare_conditionals(voice_path)
                current_voice["key"] = voice_path
            wav = model.generate(LANG_TAG.sub("", text))
            samples, sr = wav.squeeze().detach().cpu().numpy(), model.sr
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.send_json(200, state)
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/warm":
            if state["multilingual"] == "off":
                threading.Thread(target=load_multilingual, daemon=True).start()
            return self.send_json(200, state)
        if self.path != "/tts":
            return self.send_json(404, {"error": "not found"})
        if not state["ready"]:
            return self.send_json(503, {"error": state["error"] or "Chatterbox is still loading."})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            text = str(body.get("text", "")).strip()[:1000]
            if not text:
                return self.send_json(400, {"error": "No text."})
            voice_path = body.get("voice_path")
            if not voice_path:
                return self.send_json(400, {"error": "No voice sample."})
            audio = synthesize(text, voice_path)
        except Exception as exc:
            return self.send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


def quit_when_joe_closes(joe_port):
    """Exit once Joe's server has been gone for about 30 seconds, so the graphics card memory is freed."""
    import os
    import time
    import urllib.request

    misses = 0
    while True:
        time.sleep(10)
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{joe_port}/api/alive", timeout=3).close()
            misses = 0
        except Exception:
            misses += 1
            if misses >= 3:
                os._exit(0)


if __name__ == "__main__":
    if len(sys.argv) > 2:
        threading.Thread(target=quit_when_joe_closes, args=(int(sys.argv[2]),), daemon=True).start()
    threading.Thread(target=load_model, daemon=True).start()
    print(f"Chatterbox server listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
