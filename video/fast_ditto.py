"""Speed-ups for Ditto's PyTorch pipeline so it can keep up with a live call on one consumer graphics card.

Ditto's PyTorch path copies every frame's data between the processor and the graphics card at each stage:
it re-uploads the face's constant 8 MB feature volume per frame, downloads the warped features, uploads them
again for the decoder, and blends the result on the processor. These replacements keep the data on the card:

- warp: the face features are uploaded once and reused; the output stays on the card
- decode: takes and returns tensors on the card
- putback: warps the rendered face back into the full picture and blends it on the card

Call speed_up(sdk) right after creating Ditto's StreamSDK.
"""
import numpy as np
import torch
import torch.nn.functional as F

from core.models.decoder import Decoder
from core.models.warp_network import WarpNetwork
from core.utils.get_mask import get_mask

DEVICE = "cuda"
_features = {}  # id(numpy array) -> (array, tensor); the array is kept so its id can't be reused


def _feature_on_gpu(arr):
    hit = _features.get(id(arr))
    if hit is None or hit[0] is not arr:
        if len(_features) > 16:
            _features.clear()
        hit = (arr, torch.from_numpy(arr).to(DEVICE))
        _features[id(arr)] = hit
    return hit[1]


def _warp(self, feature_3d, kp_source, kp_driving):
    with torch.no_grad(), torch.autocast(device_type="cuda", dtype=torch.float16):
        return self.model(
            _feature_on_gpu(feature_3d),
            torch.from_numpy(kp_source).to(DEVICE),
            torch.from_numpy(kp_driving).to(DEVICE),
        )


def _decode(self, feature):
    with torch.no_grad(), torch.autocast(device_type="cuda", dtype=torch.float16):
        pred = self.model(feature)
    return pred[0].float().clamp(0, 1)  # (3, 512, 512) on the card, 0..1


class GpuPutBack:
    """Same result as Ditto's PutBack (cv2.warpAffine + mask blend), done on the graphics card."""

    def __init__(self):
        self.mask = torch.from_numpy(np.ascontiguousarray(get_mask(512, 512, 0.9, 0.9)[..., 0])).to(DEVICE)[None]
        self._frames = {}
        self._pixels = {}

    def _frame(self, frame_rgb):
        hit = self._frames.get(id(frame_rgb))
        if hit is None or hit[0] is not frame_rgb:
            if len(self._frames) > 16:
                self._frames.clear()
            hit = (frame_rgb, torch.from_numpy(frame_rgb).to(DEVICE).permute(2, 0, 1).float())
            self._frames[id(frame_rgb)] = hit
        return hit[1]

    def _pixel_grid(self, h, w):
        if (h, w) not in self._pixels:
            ys, xs = torch.meshgrid(torch.arange(h, device=DEVICE), torch.arange(w, device=DEVICE), indexing="ij")
            self._pixels[(h, w)] = torch.stack([xs, ys, torch.ones_like(xs)], -1).float().reshape(-1, 3)
        return self._pixels[(h, w)]

    def __call__(self, frame_rgb, render_image, M_c2o):
        h, w = frame_rgb.shape[:2]
        M = np.eye(3, dtype=np.float64)
        M[:2] = np.asarray(M_c2o, dtype=np.float64)[:2]
        # For each output pixel, find where it comes from in the 512x512 render (what cv2.warpAffine does).
        inv = torch.from_numpy(np.linalg.inv(M)).float().to(DEVICE)
        src = self._pixel_grid(h, w) @ inv.T
        grid = ((2 * src[:, :2] + 1) / 512 - 1).reshape(1, h, w, 2)
        layers = torch.cat([render_image * 255, self.mask], 0)[None]
        warped = F.grid_sample(layers, grid, mode="bilinear", padding_mode="zeros", align_corners=False)[0]
        alpha = warped[3:].clamp(0, 1)
        out = alpha * warped[:3] + (1 - alpha) * self._frame(frame_rgb)
        return out.clamp(0, 255).byte().permute(1, 2, 0).contiguous().cpu().numpy()


def speed_up(sdk):
    torch.backends.cudnn.benchmark = True
    WarpNetwork.__call__ = _warp
    Decoder.__call__ = _decode
    sdk.putback = GpuPutBack()
