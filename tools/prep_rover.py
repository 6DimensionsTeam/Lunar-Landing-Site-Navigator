# Polar rover: Space ROS lunar_pole_exploration_rover (URDF/xacro + Collada) → src/data/rover.glb
#   tools/.venv/bin/python -I tools/prep_rover.py
# Source: github.com/space-ros/simulation, models/lunar_pole_exploration_rover (Apache-2.0,
#       meshes by Robin Baran, after NASA VIPER). Downloaded to data/raw/rover (not tracked).
# Processing:
#   1. expand the xacro (only property / macro / include / ${expressions} as used by these files), giving links and joints;
#   2. one glTF node per link, transform = joint origin, joint type, axis and limits written into the node's extras.urdf,
#      the front end drives the joints per the URDF definition; the root node turns URDF's z-up into glTF's y-up;
#   3. Collada vertices are shared (normals smoothed away), so split normals again at a 35° crease angle to keep the CAD hard edges;
#   4. colours swapped for PBR materials by role (white thermal coating, gold MLI, dark blue solar cells …); the chassis
#      lemon-yellow MLI texture is graded to the same dark gold as the relay station;
#   5. glTF Transform: meshopt geometry + WebP textures, light simplification (40k triangles per wheel), keeping the node hierarchy and extras.
import ast
import io
import json
import math
import operator
import struct
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'raw' / 'rover'
OUT = ROOT / 'src' / 'data' / 'rover.glb'
TMP = ROOT / 'data' / 'raw' / 'rover_unopt.glb'
GLTF_TRANSFORM = '@gltf-transform/cli@4.5.1'
REPO = 'space-ros/simulation'
COMMIT = 'b6df73a1d4520bf1ffe4fd3138ae4630c42a01fc'
MODEL = 'models/lunar_pole_exploration_rover'
FILES = [
    'urdf/lunar_pole_exploration_rover.xacro', 'urdf/macros.xacro', 'urdf/lunar_pole_exploration_rover_properties.xacro',
    'urdf/lunar_pole_exploration_rover.gazebo', 'urdf/chassis.xacro', 'urdf/wheel.xacro', 'urdf/wheel_assembly.xacro',
    'urdf/mast_head.xacro',
    'meshes/body.dae', 'meshes/chassis.dae', 'meshes/chassis_texture.jpg', 'meshes/mast_camera.dae',
    'meshes/mast_head_pivot.dae', 'meshes/solar_panel.dae', 'meshes/suspension_left.dae', 'meshes/suspension_right.dae',
    'meshes/wheel_axle_left.dae', 'meshes/wheel_axle_right.dae', 'meshes/wheel_left.dae', 'meshes/wheel_right.dae',
]
CREASE = math.radians(35)


def fetch():
    for rel in FILES:
        dst = RAW / rel
        if dst.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        host = 'media.githubusercontent.com/media' if rel.startswith('meshes/') else 'raw.githubusercontent.com'
        url = f'https://{host}/{REPO}/{COMMIT}/{MODEL}/{rel}'
        print('Downloading', rel)
        with urllib.request.urlopen(url) as r:
            dst.write_bytes(r.read())


# ---------- xacro ----------
XACRO = '{http://wiki.ros.org/xacro}'
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.USub: operator.neg, ast.UAdd: operator.pos}


def _num(v):
    if isinstance(v, (int, float)):
        return v
    try:
        return float(v)
    except (TypeError, ValueError):
        return v


def safe_eval(expr, scope):
    # only allow arithmetic, powers, signs, numbers and variable names: the xacro files are downloaded, so never hand them to eval
    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return n.value
        if isinstance(n, ast.Name):
            if n.id not in scope:
                raise KeyError(f'xacro variable not defined: {n.id}')
            return _num(scope[n.id])
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.left), ev(n.right))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.operand))
        raise ValueError(f'unsupported syntax in xacro expression: {expr!r}')
    return ev(ast.parse(expr.strip(), mode='eval'))


def subst(text, scope):
    if text is None or '${' not in text:
        return text
    out, i = [], 0
    while True:
        j = text.find('${', i)
        if j < 0:
            out.append(text[i:])
            break
        k = text.index('}', j)
        out.append(text[i:j])
        v = safe_eval(text[j + 2:k], scope)
        out.append(repr(float(v)) if isinstance(v, (int, float)) else str(v))
        i = k + 1
    return ''.join(out)


class Xacro:
    def __init__(self, base):
        self.base = base
        self.props = {}
        self.macros = {}

    def resolve(self, fn):
        # $(find simulation)/models/<model>/urdf/x.xacro → local data/raw/rover/urdf/x.xacro
        return self.base / 'urdf' / Path(fn).name

    def load(self, path):
        return ET.parse(path).getroot()

    def expand(self, root):
        out = []
        self._walk(root, dict(self.props), out)
        return out

    def _walk(self, el, scope, out):
        for ch in list(el):
            tag = ch.tag
            if tag == XACRO + 'include':
                # .gazebo holds only simulation plugin parameters (with conditional expressions written per ROS version) and is unrelated to appearance or kinematics
                if not ch.get('filename').endswith('.gazebo'):
                    self._walk(self.load(self.resolve(ch.get('filename'))), scope, out)
            elif tag == XACRO + 'property':
                self.props[ch.get('name')] = subst(ch.get('value'), {**self.props, **scope})
                scope[ch.get('name')] = self.props[ch.get('name')]
            elif tag == XACRO + 'macro':
                self.macros[ch.get('name')] = (ch.get('params', '').split(), ch)
            elif tag.startswith(XACRO):
                name = tag[len(XACRO):]
                params, body = self.macros[name]
                inner = dict(scope)
                for p in params:
                    inner[p] = subst(ch.get(p), scope)
                self._walk(body, inner, out)
            elif tag in ('link', 'joint'):
                out.append(self._copy(ch, scope))
            # gazebo / transmission / material / ros2_control are unrelated to appearance, dropped

    def _copy(self, el, scope):
        e = ET.Element(el.tag, {k: subst(v, scope) for k, v in el.attrib.items()})
        for ch in el:
            if ch.tag == 'collision':
                continue
            if ch.tag == 'inertial':              # keep only mass from inertial (the rover card shows the URDF total mass)
                m = ch.find('mass')
                if m is not None:
                    ET.SubElement(e, 'mass', {'value': subst(m.get('value'), scope)})
                continue
            e.append(self._copy(ch, scope))
        return e


def vec(s, n=3, default=0.0):
    return [float(x) for x in s.split()] if s else [default] * n


def rpy_matrix(r, p, y):
    cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), math.sin(y)
    # URDF: R = Rz(yaw)·Ry(pitch)·Rx(roll)
    return np.array([
        [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
        [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
        [-sp, cp * sr, cp * cr],
    ])


def mat_to_quat(m):
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1) * 2
        return [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    i = int(np.argmax([m[0, 0], m[1, 1], m[2, 2]]))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = math.sqrt(1 + m[i, i] - m[j, j] - m[k, k]) * 2
    q = [0.0] * 4
    q[i] = 0.25 * s
    q[j] = (m[j, i] + m[i, j]) / s
    q[k] = (m[k, i] + m[i, k]) / s
    q[3] = (m[k, j] - m[j, k]) / s
    return q


# ---------- Normals: split by crease angle ----------
def crease_split(V, F, uv=None):
    tri = V[F]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area2 = np.linalg.norm(fn, axis=1)
    keep = area2 > 1e-14
    F, tri, fn, area2 = F[keep], tri[keep], fn[keep], area2[keep]
    fn = fn / area2[:, None]
    nF = len(F)
    corner_v = F.reshape(-1)
    corner_f = np.repeat(np.arange(nF), 3)
    # corner weight: the interior angle at that corner (large, wide-angle faces contribute more)
    ang = np.zeros((nF, 3))
    for k in range(3):
        a = tri[:, (k + 1) % 3] - tri[:, k]
        b = tri[:, (k + 2) % 3] - tri[:, k]
        c = np.einsum('ij,ij->i', a, b) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1) + 1e-20)
        ang[:, k] = np.arccos(np.clip(c, -1, 1))
    w = ang.reshape(-1)
    order = np.argsort(corner_v, kind='stable')
    cv = corner_v[order]
    starts = np.flatnonzero(np.r_[True, cv[1:] != cv[:-1]])
    ends = np.r_[starts[1:], len(cv)]
    cosT = math.cos(CREASE)
    cn = np.zeros((len(corner_v), 3))
    for s, e in zip(starts, ends):
        idx = order[s:e]
        N = fn[corner_f[idx]]
        W = w[idx]
        d = N @ N.T
        acc = (d > cosT).astype(float) * W[None, :]
        cn[idx] = acc @ N
    cn /= np.linalg.norm(cn, axis=1, keepdims=True) + 1e-20
    # corners on the same original vertex with near-identical normals merge into one new vertex
    q = np.round(cn * 2048).astype(np.int32)
    key = np.c_[corner_v, q]
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    nV = len(uniq)
    pos = V[uniq[:, 0]]
    nrm = np.zeros((nV, 3))
    np.add.at(nrm, inv, cn)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-20
    out_uv = uv[uniq[:, 0]] if uv is not None else None
    return pos.astype(np.float32), nrm.astype(np.float32), out_uv, inv.reshape(-1, 3).astype(np.uint32)


# ---------- Materials ----------
def srgb_to_lin(c):
    c = np.asarray(c, float) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


GOLD = (217, 162, 74)            # matching the gold MLI on the relay station
# source colours (sRGB 0–255) → (material name, new sRGB colour or None to keep, metallic, roughness)
PALETTE = {
    (230, 235, 235): ('white', None, 0.0, 0.62),
    (229, 235, 237): ('white', None, 0.0, 0.62),
    (255, 255, 255): ('white', None, 0.0, 0.62),
    (138, 138, 149): ('grey', None, 0.55, 0.45),
    (165, 158, 150): ('alu', None, 0.8, 0.42),
    (192, 192, 192): ('alu', None, 0.8, 0.42),
    (128, 128, 128): ('alu_dark', None, 0.75, 0.5),
    (252, 188, 132): ('gold', GOLD, 0.9, 0.38),
    (0, 0, 0): ('black', (18, 18, 20), 0.0, 0.5),
    (81, 63, 53): ('rubber', None, 0.0, 0.8),
    (99, 102, 219): ('glass', (28, 34, 58), 0.1, 0.08),
    (176, 156, 135): ('bronze', None, 0.7, 0.4),
    (203, 210, 239): ('rim', (182, 188, 200), 0.85, 0.38),
    (202, 209, 238): ('rim', (182, 188, 200), 0.85, 0.38),
    # cells: the source is saturated blue, a few blues tiled into a grid; swap in the dark navy of real cells, with only a slight difference between tiles
    (0, 63, 222): ('cell', (16, 30, 74), 0.35, 0.22),
    (50, 77, 255): ('cell_hi', (17, 31, 76), 0.35, 0.22),
    (32, 48, 255): ('cell', (16, 30, 74), 0.35, 0.22),
    (0, 0, 192): ('cell_lo', (15, 28, 71), 0.35, 0.23),
}


def foil_texture():
    # lemon yellow → dark gold: take luminance, multiply by the relay station's gold MLI, flatten the contrast a little
    im = Image.open(RAW / 'meshes' / 'chassis_texture.jpg').convert('RGB')
    a = np.asarray(im, float) / 255
    L = a @ np.array([0.2126, 0.7152, 0.0722])
    L = 0.25 + 0.85 * (L - L.mean()) + L.mean() * 0.75
    tint = np.array(GOLD) / 255
    out = np.clip(L[..., None] * tint[None, None, :] * 1.15, 0, 1)
    buf = io.BytesIO()
    Image.fromarray((out * 255).astype(np.uint8)).save(buf, 'PNG')
    return buf.getvalue()


# ---------- glTF output ----------
class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.doc = {'asset': {'version': '2.0', 'generator': 'tools/prep_rover.py'}, 'scene': 0, 'scenes': [{'nodes': []}],
                    'nodes': [], 'meshes': [], 'accessors': [], 'bufferViews': [], 'buffers': [{}], 'materials': []}
        self.mat_ix = {}

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.bin += data
        self.doc['bufferViews'].append(v)
        return len(self.doc['bufferViews']) - 1

    def accessor(self, arr, kind, target, minmax=False):
        comp = {np.float32: 5126, np.uint32: 5125, np.uint16: 5123}[arr.dtype.type]
        a = {'bufferView': self.view(arr.tobytes(), target), 'componentType': comp, 'count': len(arr), 'type': kind}
        if minmax:
            a['min'] = arr.min(axis=0).tolist()
            a['max'] = arr.max(axis=0).tolist()
        self.doc['accessors'].append(a)
        return len(self.doc['accessors']) - 1

    def material(self, name, rgb, metal, rough, tex=None):
        key = (name, tuple(rgb), tex is not None)
        if key in self.mat_ix:
            return self.mat_ix[key]
        lin = srgb_to_lin(rgb).tolist()
        pbr = {'baseColorFactor': lin + [1.0], 'metallicFactor': metal, 'roughnessFactor': rough}
        if tex is not None:
            if 'images' not in self.doc:
                self.doc['images'], self.doc['textures'], self.doc['samplers'] = [], [], [{'wrapS': 10497, 'wrapT': 10497}]
            self.doc['images'].append({'bufferView': self.view(tex), 'mimeType': 'image/png'})
            self.doc['textures'].append({'source': len(self.doc['images']) - 1, 'sampler': 0})
            pbr['baseColorTexture'] = {'index': len(self.doc['textures']) - 1}
            pbr['baseColorFactor'] = [1.0, 1.0, 1.0, 1.0]
        self.doc['materials'].append({'name': name, 'pbrMetallicRoughness': pbr})
        self.mat_ix[key] = len(self.doc['materials']) - 1
        return self.mat_ix[key]

    def mesh(self, name, prims):
        out = []
        for mat, pos, nrm, uv, idx in prims:
            attrs = {'POSITION': self.accessor(pos, 'VEC3', 34962, True), 'NORMAL': self.accessor(nrm, 'VEC3', 34962)}
            if uv is not None:
                attrs['TEXCOORD_0'] = self.accessor(uv, 'VEC2', 34962)
            ix = idx.reshape(-1).astype(np.uint16 if len(pos) < 65536 else np.uint32)
            out.append({'attributes': attrs, 'indices': self.accessor(ix, 'SCALAR', 34963), 'material': mat})
        self.doc['meshes'].append({'name': name, 'primitives': out})
        return len(self.doc['meshes']) - 1

    def node(self, **kw):
        self.doc['nodes'].append({k: v for k, v in kw.items() if v is not None})
        return len(self.doc['nodes']) - 1

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.doc['buffers'][0]['byteLength'] = len(self.bin)
        js = json.dumps(self.doc, ensure_ascii=False, separators=(',', ':')).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        body = struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(self.bin), 0x004E4942) + bytes(self.bin)
        path.write_bytes(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


def load_visual(g, dae, foil_png, stats):
    s = trimesh.load(RAW / 'meshes' / dae, force='scene', process=False)
    groups = {}
    for m in s.dump(concatenate=False):
        mat = getattr(m.visual, 'material', None)
        uv = getattr(m.visual, 'uv', None)
        tex = getattr(mat, 'baseColorTexture', None) if mat is not None else None
        rgba = tuple(int(x) for x in (getattr(mat, 'baseColorFactor', None) if mat is not None and getattr(mat, 'baseColorFactor', None) is not None else (255, 255, 255, 255)))
        if tex is not None and uv is not None:
            mi = g.material('foil', (255, 255, 255), 0.9, 0.42, foil_png)
            uvf = uv.astype(np.float32).copy()
            uvf[:, 1] = 1 - uvf[:, 1]
        else:
            name, rgb, metal, rough = PALETTE.get(rgba[:3], ('misc', None, 0.3, 0.5))
            if rgba[:3] not in PALETTE:
                print('  unregistered colour', dae, rgba)
            mi = g.material(name, rgb or rgba[:3], metal, rough)
            uvf = None
        pos, nrm, uvo, idx = crease_split(np.asarray(m.vertices, float), np.asarray(m.faces, np.int64), uvf)
        gr = groups.setdefault(mi, [[], [], [], [], 0])
        gr[0].append(pos); gr[1].append(nrm); gr[2].append(uvo); gr[3].append(idx + gr[4]); gr[4] += len(pos)
        stats['tris'] += len(idx)
    prims = []
    for mi, (P, N, U, I, _) in groups.items():
        uv = np.concatenate(U).astype(np.float32) if all(u is not None for u in U) else None
        prims.append((mi, np.concatenate(P), np.concatenate(N), uv, np.concatenate(I)))
    return g.mesh(Path(dae).stem, prims)


def main():
    fetch()
    xa = Xacro(RAW)
    elems = xa.expand(xa.load(RAW / 'urdf' / 'lunar_pole_exploration_rover.xacro'))
    links = {e.get('name'): e for e in elems if e.tag == 'link'}
    joints = [e for e in elems if e.tag == 'joint']
    child_of = {j.find('child').get('link'): j for j in joints}
    children = {}
    for j in joints:
        children.setdefault(j.find('parent').get('link'), []).append(j.find('child').get('link'))
    roots = [n for n in links if n not in child_of]
    assert len(roots) == 1, roots
    print('links', len(links), 'joints', len(joints), 'root', roots[0])

    g = Glb()
    foil_png = foil_texture()
    mesh_cache, stats = {}, {'tris': 0}

    def build(link):
        el = links[link]
        extras = {'link': link}
        if el.find('mass') is not None:
            extras['mass'] = float(el.find('mass').get('value'))
        T = np.eye(4)
        j = child_of.get(link)
        if j is not None:
            o = j.find('origin')
            xyz = vec(o.get('xyz') if o is not None else None)
            rpy = vec(o.get('rpy') if o is not None else None)
            T[:3, :3] = rpy_matrix(*rpy)
            T[:3, 3] = xyz
            extras.update(joint=j.get('name'), type=j.get('type'))
            ax = j.find('axis')
            if j.get('type') != 'fixed':
                extras['axis'] = vec(ax.get('xyz') if ax is not None else '1 0 0')
                lim = j.find('limit')
                if lim is not None and lim.get('lower') is not None:
                    extras['lower'], extras['upper'] = float(lim.get('lower')), float(lim.get('upper'))
        kids = []
        for vis in el.findall('visual'):
            mesh_el = vis.find('geometry/mesh')
            if mesh_el is None:
                continue               # the camera's 0.5 mm cube and the like, skipped
            dae = Path(mesh_el.get('filename')).name
            if dae not in mesh_cache:
                mesh_cache[dae] = load_visual(g, dae, foil_png, stats)
            o = vis.find('origin')
            vT = np.eye(4)
            vT[:3, :3] = rpy_matrix(*vec(o.get('rpy') if o is not None else None))
            vT[:3, 3] = vec(o.get('xyz') if o is not None else None)
            kw = {}
            if not np.allclose(vT, np.eye(4)):
                kw = {'translation': vT[:3, 3].tolist(), 'rotation': mat_to_quat(vT[:3, :3])}
            kids.append(g.node(name=link + ':visual', mesh=mesh_cache[dae], **kw))
        for c in children.get(link, []):
            kids.append(build(c))
        return g.node(name=link, translation=T[:3, 3].tolist(), rotation=mat_to_quat(T[:3, :3]),
                      children=kids or None, extras={'urdf': extras})

    top = build(roots[0])
    # URDF z-up, x forward → glTF y-up; the nose still points along local +x
    root = g.node(name='rover', rotation=[-math.sqrt(0.5), 0, 0, math.sqrt(0.5)], children=[top], extras={'urdf': {
        'robot': 'lunar_pole_exploration_rover', 'source': f'https://github.com/{REPO}/tree/{COMMIT}/{MODEL}',
        'license': 'Apache-2.0', 'author': 'Robin Baran (Space ROS)'}})
    g.doc['scenes'][0]['nodes'] = [root]
    g.doc['asset']['copyright'] = 'Space ROS simulation · lunar_pole_exploration_rover · Apache-2.0'
    g.write(TMP)
    print('uncompressed', TMP.stat().st_size // 1024, 'KB', stats['tris'], 'triangles', len(g.doc['materials']), 'materials', len(mesh_cache), 'meshes')

    subprocess.run(['npx', '--yes', GLTF_TRANSFORM, 'optimize', str(TMP), str(OUT),
                    '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '1024',
                    '--simplify', 'true', '--simplify-error', '0.0015',
                    '--flatten', 'false', '--join', 'false', '--instance', 'false', '--palette', 'false', '--prune', 'false'],
                   check=True)
    print('output', OUT, OUT.stat().st_size // 1024, 'KB')


if __name__ == '__main__':
    sys.exit(main())
