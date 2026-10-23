"""Local talking-face server for Joe's video calls. Joe's Node server starts it.

POST /render?face=<image path>   body: audio (wav or mp3)  ->  stream of frames
GET  /idle?face=<image path>                               ->  stream of frames for a silent idle loop
GET  /health                                               ->  {"ready": true, ...}

A frame stream is a series of [4-byte big-endian length][JPEG bytes], 25 frames per second of audio,
sent as soon as each frame is drawn so the call screen can start playing before the sentence is done.
"""
import io
import json
import math
import os
import queue
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DITTO = os.path.join(HERE, "ditto")
CKPT = os.path.join(HERE, "checkpoints")
sys.path.insert(0, DITTO)
sys.path.insert(0, HERE)
os.chdir(DITTO)

import cv2
import librosa
import numpy as np
import torch

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5176
FPS = 25
IDLE_SECONDS = 4
SAMPLING_STEPS = 10  # Ditto's default is 50; 10 looks the same here and leaves more time for drawing frames

state = {"ready": False, "error": None, "device": None}
sdk = None
faces = {}  # path -> Face


class Face:
    """A face picture registered with Ditto, ready to animate."""

    def __init__(self, path):
        from core.atomic_components.avatar_registrar import smooth_x_s_info_lst

        kw = dict(sdk.default_kwargs)
        self.path, self.mtime = path, os.path.getmtime(path)
        info = sdk.avatar_registrar(
            path,
            max_dim=kw.get("max_size", 1920),
            n_frames=-1,
            crop_scale=kw.get("crop_scale", 2.3),
            crop_vx_ratio=kw.get("crop_vx_ratio", 0),
            crop_vy_ratio=kw.get("crop_vy_ratio", -0.125),
            crop_flag_do_rot=kw.get("crop_flag_do_rot", True),
        )
        if len(info["x_s_info_lst"]) > 1:
            info["x_s_info_lst"] = smooth_x_s_info_lst(info["x_s_info_lst"], smo_k=kw.get("smo_k_s", 13))
        self.info = info
        self.kw = kw

    def activate(self):
        """Point Ditto's shared components at this face (cheap; done before each render)."""
        kw, info = self.kw, self.info
        sdk.source_info = info
        sdk.source_info_frames = len(info["x_s_info_lst"])
        sdk.condition_handler.setup(info, kw.get("emo", 4), eye_f0_mode=False, ch_info=None)
        sdk.audio2motion.setup(
            sdk.condition_handler.x_s_info_0,
            overlap_v2=kw.get("overlap_v2", 10),
            fix_kp_cond=kw.get("fix_kp_cond", 0),
            fix_kp_cond_dim=kw.get("fix_kp_cond_dim", None),
            sampling_timesteps=SAMPLING_STEPS,
            online_mode=False,
            v_min_max_for_clip=kw.get("v_min_max_for_clip", None),
            smo_k_d=kw.get("smo_k_d", 3),
        )
        sdk.motion_stitch.setup(
            N_d=-1,
            use_d_keys=kw.get("use_d_keys", None),
            relative_d=kw.get("relative_d", True),
            drive_eye=kw.get("drive_eye", None),
            delta_eye_arr=kw.get("delta_eye_arr", None),
            delta_eye_open_n=kw.get("delta_eye_open_n", 0),
            fade_out_keys=kw.get("fade_out_keys", ("exp",)),
            fade_type=kw.get("fade_type", ""),
            flag_stitching=kw.get("flag_stitching", True),
            is_image_flag=info["is_image_flag"],
            x_s_info=info["x_s_info_lst"][0],
            d0=None,
            ch_info=None,
            overall_ctrl_info={},
        )


def get_face(path):
    face = faces.get(path)
    if face is None or face.mtime != os.path.getmtime(path):
        face = faces[path] = Face(path)
    return face


def frames_for(face, audio):
    """Yields RGB frames (25 per second of audio), drawn one at a time on the graphics card."""
    from core.atomic_components.condition_handler import _mirror_index

    face.activate()
    num_frames = math.ceil(len(audio) / 16000 * FPS)
    sdk.motion_stitch.set_Nd(num_frames)

    # Head and mouth movement for the whole sentence first (fast), then draw each frame.
    aud_cond_all = sdk.condition_handler(sdk.wav2feat.wav2feat(audio), 0)
    seq_frames, step = sdk.audio2motion.seq_frames, sdk.audio2motion.valid_clip_len
    kp_seq, idx = None, 0
    while idx < len(aud_cond_all):
        cond = aud_cond_all[idx : idx + seq_frames][None]
        if cond.shape[1] < seq_frames:
            cond = np.concatenate([cond, np.stack([cond[:, -1]] * (seq_frames - cond.shape[1]), 1)], 1)
        kp_seq = sdk.audio2motion(cond, kp_seq)
        idx += step
    kp_seq = kp_seq[:, : len(aud_cond_all)]
    kp_seq = sdk.audio2motion._smo(kp_seq, 0, kp_seq.shape[1])

    info = face.info
    for i, x_d_info in enumerate(sdk.audio2motion.cvt_fmt(kp_seq)[:num_frames]):
        fi = _mirror_index(i, sdk.source_info_frames)
        x_s, x_d = sdk.motion_stitch(info["x_s_info_lst"][fi], x_d_info)
        rendered = sdk.decode_f3d(sdk.warp_f3d(info["f_s_lst"][fi], x_s, x_d))
        yield sdk.putback(info["img_rgb_lst"][fi], rendered, info["M_c2o_lst"][fi])


class Job:
    def __init__(self, face_path, audio):
        self.face_path, self.audio = face_path, audio
        self.out = queue.Queue(maxsize=50)  # frames, then None (done) or an Exception
        self.cancel = threading.Event()


jobs = queue.Queue()


def gpu_worker():
    """Loads the model and draws every frame on this one thread. PyTorch and cuDNN set themselves up again
    for each new thread that uses the card, which cost over a second per sentence when each request did its own."""
    load_model()
    while True:
        job = jobs.get()
        t0 = time.perf_counter()
        count, t_first = 0, None
        try:
            for frame in frames_for(get_face(job.face_path), job.audio):
                if job.cancel.is_set():
                    break
                job.out.put(frame)
                count += 1
                t_first = t_first or time.perf_counter()
            job.out.put(None)
        except Exception as exc:
            job.out.put(exc)
            continue
        took = time.perf_counter() - t0
        print(f"rendered {len(job.audio) / 16000:.1f}s of audio: first frame {(t_first or t0) - t0:.2f}s, "
              f"{count} frames in {took:.1f}s ({count / max(took, 1e-6):.0f} fps)", flush=True)


def load_model():
    global sdk
    try:
        from stream_pipeline_offline import StreamSDK
        import fast_ditto

        sdk = StreamSDK(
            os.path.join(CKPT, "ditto_cfg", "v0.4_hubert_cfg_pytorch.pkl"),
            os.path.join(CKPT, "ditto_pytorch"),
        )
        fast_ditto.speed_up(sdk)
        state["device"] = "cuda" if torch.cuda.is_available() else "cpu"
        state["ready"] = True
        print(f"Face server ready on {state['device']}", flush=True)
    except Exception as exc:
        state["error"] = f"{type(exc).__name__}: {exc}"
        print("Face server failed to load:", state["error"], flush=True)


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

    def stream_frames(self, face_path, audio):
        if not state["ready"]:
            return self.send_json(503, {"error": state["error"] or "The face engine is still loading."})
        if not face_path or not os.path.isfile(face_path):
            return self.send_json(400, {"error": "No face picture."})
        job = Job(face_path, audio)
        jobs.put(job)
        first = job.out.get()
        if isinstance(first, Exception):
            return self.send_json(500, {"error": f"{type(first).__name__}: {first}"})
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            frame = first
            while frame is not None and not isinstance(frame, Exception):
                ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(frame, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
                self.wfile.write(struct.pack(">I", len(jpg)) + jpg.tobytes())
                self.wfile.flush()
                frame = job.out.get()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # the call screen moved on (Joe was hushed or the call ended)
        finally:
            job.cancel.set()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self.send_json(200, state)
        if url.path == "/idle":
            face = parse_qs(url.query).get("face", [""])[0]
            return self.stream_frames(face, np.zeros(16000 * IDLE_SECONDS, dtype=np.float32))
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/render":
            return self.send_json(404, {"error": "not found"})
        face = parse_qs(url.query).get("face", [""])[0]
        try:
            data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            audio, _ = librosa.load(io.BytesIO(data), sr=16000, mono=True)
        except Exception as exc:
            return self.send_json(400, {"error": f"Couldn't read the audio: {exc}"})
        self.stream_frames(face, audio.astype(np.float32))


def quit_when_joe_closes(joe_port):
    """Exit once Joe's server has been gone for about 30 seconds, so the graphics card memory is freed."""
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
    threading.Thread(target=gpu_worker, daemon=True).start()
    print(f"Face server listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
