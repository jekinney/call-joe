# Replaces Ditto's core/utils/blend/__init__.py (copied in by setup-ditto.ps1).
# Ditto's blend step is Cython that needs Microsoft's C++ compiler to build on Windows.
# Use the compiled version when it builds, otherwise this NumPy version, which does the same math.
import numpy as np

try:
    import pyximport

    pyximport.install()
    from .blend import blend_images_cy
except Exception:

    def blend_images_cy(mask_warped, frame_warped, frame_rgb, result):
        mask = mask_warped[..., None]
        blended = mask * frame_warped + (1.0 - mask) * frame_rgb
        np.clip(blended, 0, 255, out=blended)
        result[...] = blended.astype(np.uint8)
