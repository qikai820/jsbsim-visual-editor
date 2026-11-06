#!/usr/bin/env python3
"""Rebuild the bundled CC0 scenery maps; normal app use is entirely offline.

Requires Pillow only for this development-time import step. Source URLs and
checksums are pinned in the asset manifest. --check verifies bundled files
without network access; --source-dir can reuse already downloaded source JPGs.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.request

from PIL import Image


ASSET_DIR = Path(__file__).resolve().parents[1] / "client/public/scenery/polyhaven"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--source-dir", type=Path)
    args = parser.parse_args()
    manifest_path = ASSET_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    total = 0
    for asset in manifest["assets"]:
        output = ASSET_DIR / asset["file"]
        if not args.check:
            if args.source_dir:
                content = (args.source_dir / (asset["id"] + ".jpg")).read_bytes()
            else:
                request = urllib.request.Request(asset["source_url"], headers={
                    "User-Agent": "JSBSim-Visual-Editor/1.0 (CC0 scenery asset import)",
                    "Referer": "https://polyhaven.com/",
                })
                with urllib.request.urlopen(request, timeout=60) as response:
                    content = response.read()
            if hashlib.md5(content).hexdigest() != asset["source_md5"]:
                raise ValueError("Source checksum mismatch: " + asset["id"])
            with Image.open(io.BytesIO(content)) as image:
                image.convert("RGB").resize(tuple(asset["size"]), Image.Resampling.LANCZOS).save(
                    output, "JPEG", quality=85, optimize=True, progressive=True,
                )
            asset["sha256"] = hashlib.sha256(output.read_bytes()).hexdigest()
        content = output.read_bytes()
        if hashlib.sha256(content).hexdigest() != asset["sha256"]:
            raise ValueError("Bundled checksum mismatch: " + asset["file"])
        with Image.open(output) as image:
            if image.size != tuple(asset["size"]):
                raise ValueError("Unexpected dimensions: " + asset["file"])
            image.verify()
        total += len(content)
        print(f'{asset["file"]}: {len(content):,} bytes, verified')
    if not args.check:
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"Total bundled JPEGs: {total:,} bytes")


if __name__ == "__main__":
    main()
