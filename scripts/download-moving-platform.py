#!/usr/bin/env python3
"""Download pinned CC0 Kenney watercraft and embed its palette in a portable GLB."""
import hashlib
import argparse
import base64
import json
from pathlib import Path
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'client/public/scenery/moving-platform'
COMMIT = '3694c6879e487c108f55677be7dd2ca75b07cc3b'
BASE = f'https://raw.githubusercontent.com/shorepine/kenney/{COMMIT}/3d/watercraft/'


def download(name):
    url = f'https://api.github.com/repos/shorepine/kenney/contents/3d/watercraft/{name}?ref={COMMIT}'
    payload = subprocess.run(['curl', '-fLsS', '--max-time', '30', url], check=True, capture_output=True).stdout
    return base64.b64decode(json.loads(payload)['content'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, help='Use an already downloaded pack directory')
    args = parser.parse_args()
    read = lambda name: (args.source_dir / name).read_bytes() if args.source_dir else download(name)
    model = read('ship-cargo-c.glb')
    palette = read('Textures/colormap.png')
    size = struct.unpack_from('<I', model, 12)[0]
    doc = json.loads(model[20:20 + size])
    binary_size = struct.unpack_from('<I', model, 20 + size)[0]
    binary = model[28 + size:28 + size + binary_size]
    binary += b'\0' * (-len(binary) % 4)
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(palette)})
    doc['images'] = [{'bufferView': len(doc['bufferViews']) - 1, 'mimeType': 'image/png', 'name': 'Kenney palette'}]
    binary += palette
    doc['buffers'][0]['byteLength'] = len(binary)
    binary += b'\0' * (-len(binary) % 4)
    doc['asset']['extras'] = {'author': 'Kenney', 'license': 'CC0-1.0', 'source': 'https://kenney.nl/assets/watercraft-kit'}
    encoded = json.dumps(doc, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    result = struct.pack('<III', 0x46546c67, 2, 28 + len(encoded) + len(binary))
    result += struct.pack('<II', len(encoded), 0x4e4f534a) + encoded
    result += struct.pack('<II', len(binary), 0x004e4942) + binary
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / 'vessel.glb').write_bytes(result)
    manifest = {
        'name': '移动平台工作船', 'author': 'Kenney', 'license': 'CC0-1.0',
        'source': 'https://kenney.nl/assets/watercraft-kit',
        'download': BASE + 'ship-cargo-c.glb', 'mirrorCommit': COMMIT,
        'sourceSha256': hashlib.sha256(model).hexdigest(),
        'paletteSha256': hashlib.sha256(palette).hexdigest(),
        'file': 'vessel.glb', 'sha256': hashlib.sha256(result).hexdigest(), 'bytes': len(result),
        'changes': ['Embedded palette PNG; geometry preserved.', 'Runtime adds a parameterized landing deck and guide rods.'],
    }
    complete = DEST / 'moving-platform.glb'
    if complete.exists():
        assembled = complete.read_bytes()
        manifest['assembled'] = {'file': complete.name, 'sha256': hashlib.sha256(assembled).hexdigest(),
            'bytes': len(assembled), 'deckLengthM': 4, 'deckWidthM': 3, 'rodLengthM': 1.5,
            'rodSpacingM': .36, 'contactMode': 2,
            'generator': 'createMovingPlatformModel / three.js GLTFExporter; tests/moving-platform-scene-ui.mjs'}
    previous = DEST / 'visual-model.json'
    if previous.exists():
        collision = json.loads(previous.read_text()).get('collision', {})
        if collision.get('sourceSha256') == manifest['sha256']:
            manifest['collision'] = collision
    (DEST / 'visual-model.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == '__main__':
    main()
