"""Local Chatterbox voice server for Joe. Joe's Node server starts it and sends it text to speak.

POST /tts  {"text": ..., "voice_path": ...}  ->  audio/wav
GET  /health                                                        ->  {"ready": true, ...}
"""
import io
import json
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5175

state = {"ready": False, "error": None, "device": None, "model": None}
model = None
gpu_lock = threading.Lock()  # one GPU, so one sentence at a time
current_voice = {"key": None}


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


def synthesize(text, voice_path):
    with gpu_lock:
        # Reuse the voice's conditioning between sentences instead of re-reading the clip each time.
        if current_voice["key"] != voice_path:
            model.prepare_conditionals(voice_path)
            current_voice["key"] = voice_path
        wav = model.generate(text)
    samples = wav.squeeze().detach().cpu().clamp(-1, 1).numpy()
    pcm = (samples * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(model.sr)
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
