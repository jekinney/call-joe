"""Local picture server: makes the photos friends text you, on the graphics card. Call Joe's Node server starts it
(with the voice engine's Python) and asks it for a picture only when nothing in the friend's album fits.

POST /make  {"prompt": ..., "negative": ..., "refs": [image paths], "out": path}  ->  {"ok": true}
GET  /health                                                                       ->  {"ready": true, ...}

The picture model is RealVisXL 5.0 (Stable Diffusion XL, photo style). IP-Adapter lets album pictures guide a new
one, so Elena's kids or Savannah's heels look the same from photo to photo. The model loads on the first request
and unloads after a while unused, to give the graphics card back to voice and video.
"""
import json
import sys
import warnings
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

warnings.filterwarnings("ignore", message=".*cannot run with `cpu` device.*")  # it only waits there
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5177
MODEL = "SG161222/RealVisXL_V5.0"
IDLE_SECONDS = 60 * 60  # frees the memory (about 8 GB) after an hour without pictures
NEEDS_GB = 9.5  # free graphics memory needed to draw
REF_STRENGTH = 0.35  # how strongly album pictures guide the new one (0 none, 1 copies them); higher drowns out the scene

state = {"ready": True, "error": None, "loaded": False}
pipe = None
lock = threading.Lock()
last_used = {"at": 0.0}


def load():
    global pipe
    if pipe is not None:
        return pipe
    # The voice engine's diffusers (0.29, pinned by Chatterbox) still imports Flax names newer transformers dropped.
    import transformers.utils as tu

    for name, value in (("FLAX_WEIGHTS_NAME", "flax_model.msgpack"), ("FLAX_WEIGHTS_INDEX_NAME", "flax_model.msgpack.index.json")):
        if not hasattr(tu, name):
            setattr(tu, name, value)
    from diffusers import DPMSolverMultistepScheduler, StableDiffusionXLPipeline

    started = time.time()

    p = StableDiffusionXLPipeline.from_pretrained(MODEL, torch_dtype=torch.float16, variant="fp16")
    p.scheduler = DPMSolverMultistepScheduler.from_config(p.scheduler.config, use_karras_sigmas=True)
    p.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter-plus_sdxl_vit-h.safetensors",
                      image_encoder_folder="models/image_encoder")
    pipe = p  # waits in memory; it only moves onto the graphics card while drawing, to leave room for voice and video
    state["loaded"] = True
    print(f"Picture model ready ({time.time() - started:.0f} s to load)", flush=True)
    return pipe


def unload_when_idle():
    global pipe
    while True:
        time.sleep(30)
        with lock:
            if pipe is not None and time.time() - last_used["at"] > IDLE_SECONDS:
                pipe = None
                state["loaded"] = False
                torch.cuda.empty_cache()
                print("Picture model unloaded (idle)", flush=True)


def make(prompt, negative, refs, out):
    from PIL import Image

    with lock:
        p = load()
        last_used["at"] = time.time()
        images = [Image.open(r).convert("RGB") for r in refs[:3]]
        p.set_ip_adapter_scale(REF_STRENGTH if images else 0.0)
        free = torch.cuda.mem_get_info()[0] / 2**30
        if free < NEEDS_GB:  # drawing with too little room spills into system memory and takes an hour
            raise MemoryError(f"Only {free:.1f} GB of graphics memory free; pictures need {NEEDS_GB} GB.")
        started = time.time()
        p.to("cuda")
        try:
            image = p(
                prompt=prompt,
                negative_prompt=negative,
                ip_adapter_image=[images or [Image.new("RGB", (224, 224), (128, 128, 128))]],
                width=832, height=1216,  # a phone photo, held upright
                num_inference_steps=28, guidance_scale=5.0,
            ).images[0]
        finally:
            p.to("cpu")
            torch.cuda.empty_cache()
        print(f"Picture made in {time.time() - started:.0f} s ({free:.1f} GB was free)", flush=True)
        last_used["at"] = time.time()
    image.save(out, quality=90)


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
        if self.path != "/make":
            return self.send_json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            prompt, out = str(body.get("prompt", "")).strip()[:1500], body.get("out")
            if not prompt or not out:
                return self.send_json(400, {"error": "Need a prompt and where to save the picture."})
            make(prompt, str(body.get("negative", ""))[:1500], list(body.get("refs") or []), out)
        except MemoryError as exc:
            return self.send_json(503, {"error": str(exc)})
        except Exception as exc:
            print("Making a picture failed:", type(exc).__name__, exc, flush=True)
            return self.send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
        self.send_json(200, {"ok": True})


def quit_when_joe_closes(joe_port):
    """Exit once Joe's server has been gone for about 30 seconds, so the graphics card memory is freed."""
    import os
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
    threading.Thread(target=unload_when_idle, daemon=True).start()
    print(f"Picture server listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
