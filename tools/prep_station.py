# Relay station core module: NASA Gateway Core model → src/data/station.glb
#   tools/.venv/bin/python tools/prep_station.py
# Source: NASA 3D Resources (github.com/nasa/NASA-3D-Resources, “free and without copyright”),
#       built by Alberto G. Bertolin and Bradley W. Reynolds of the JSC Graphics and Animation Lab.
# Processing: erase the Government of Canada mark from the robotic arm texture (government marks are not public domain), then use glTF Transform
#       to compress to WebP textures (≤1024) + meshopt geometry, keeping the node hierarchy (the solar wings rotate separately).
import io
import json
import struct
import subprocess
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'raw'
SRC_URL = 'https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/Gateway/Gateway%20Core.glb'
OUT = ROOT / 'src' / 'data' / 'station.glb'
GLTF_TRANSFORM = '@gltf-transform/cli@4.5.1'

# Bounds of the "Canada" wordmark on DSXR_BaseColor (1024² texture, pixels), covered with the texture from the same band directly below
MARK = (27, 653, 73, 818)
CLONE_DY = 190


def read_glb(b):
    magic, _, length = struct.unpack('<III', b[:12])
    assert magic == 0x46546C67 and length == len(b)
    jlen, jtype = struct.unpack('<II', b[12:20])
    doc = json.loads(b[20:20 + jlen])
    off = 20 + jlen
    blen, btype = struct.unpack('<II', b[off:off + 8])
    assert btype == 0x004E4942
    return doc, b[off + 8:off + 8 + blen]


def write_glb(doc, views):
    # views: the bytes of each bufferView, repacked into a single buffer with 4-byte alignment
    bin_ = bytearray()
    for bv, data in zip(doc['bufferViews'], views):
        bin_ += b'\0' * (-len(bin_) % 4)
        bv['byteOffset'] = len(bin_)
        bv['byteLength'] = len(data)
        bin_ += data
    bin_ += b'\0' * (-len(bin_) % 4)
    doc['buffers'] = [{'byteLength': len(bin_)}]
    j = json.dumps(doc, separators=(',', ':')).encode()
    j += b' ' * (-len(j) % 4)
    total = 12 + 8 + len(j) + 8 + len(bin_)
    return (struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(j), 0x4E4F534A) + j
            + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_))


def erase_mark(png):
    im = Image.open(io.BytesIO(png))
    x0, y0, x1, y1 = MARK
    patch = im.crop((x0, y0 + CLONE_DY, x1, y1 + CLONE_DY))
    im.paste(patch, (x0, y0))
    out = io.BytesIO()
    im.save(out, format='PNG')
    return out.getvalue()


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    src = RAW / 'gateway-core.glb'
    if not src.exists():
        print('Downloading', SRC_URL)
        urllib.request.urlretrieve(SRC_URL, src)
    doc, bin_ = read_glb(src.read_bytes())
    views = [bin_[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']] for bv in doc['bufferViews']]
    hit = [im for im in doc['images'] if im.get('name') == 'DSXR_BaseColor']
    assert len(hit) == 1, 'DSXR_BaseColor texture not found; the source file may have changed'
    vi = hit[0]['bufferView']
    views[vi] = erase_mark(views[vi])
    clean = RAW / 'gateway-core-clean.glb'
    clean.write_bytes(write_glb(doc, views))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        'npx', '--yes', GLTF_TRANSFORM, 'optimize', str(clean), str(OUT),
        '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '1024',
        '--simplify', 'false', '--flatten', 'false', '--join', 'false', '--palette', 'false',
    ], check=True)
    print(OUT, f'{OUT.stat().st_size / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
