"""Shrinks an album picture in place to phone size (longest side 1600 px), keeping its format. Used by the weekly
tidy-up in server.mjs after the original is copied to the Desktop. Prints the new size in bytes.

    voice\\.venv\\Scripts\\python.exe tools\\shrink-picture.py <picture>
"""
import os
import sys

from PIL import Image, ImageOps

path = sys.argv[1]
im = ImageOps.exif_transpose(Image.open(path))
im.thumbnail((1600, 1600))
ext = os.path.splitext(path)[1].lower()
if ext in (".jpg", ".jpeg"):
    im.convert("RGB").save(path, quality=85, optimize=True)
elif ext == ".png":
    im.save(path, optimize=True)
else:
    im.save(path, quality=85)
print(os.path.getsize(path))
