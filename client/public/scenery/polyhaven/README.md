# Poly Haven scenery assets

These downloaded photographic assets are **CC0-1.0**. The Poly Haven asset
license is at <https://polyhaven.com/license>. This applies to the media in this
directory, independently of the application's source-code license.

| Bundled file | Original asset | Authors | Runtime size |
| --- | --- | --- | --- |
| `sky.jpg` | [Kloppenheim 03 (Pure Sky)](https://polyhaven.com/a/kloppenheim_03_puresky) | Greg Zaal; Jarod Guest | 1024 × 512 |
| `grass.jpg` | [Grass Ground](https://polyhaven.com/a/grass_ground) | Charlotte Baglioni | 512 × 512 |
| `asphalt.jpg` | [Asphalt 02](https://polyhaven.com/a/asphalt_02) | Rob Tuytel | 512 × 512 |
| `concrete.jpg` | [Concrete Floor 01](https://polyhaven.com/a/concrete_floor_01) | Rob Tuytel | 256 × 256 |

The sky uses Poly Haven's official tonemapped JPG panorama. The surface images
use the official 1K diffuse JPGs. They have been resized with Lanczos and encoded
as quality-85 JPEGs. No generative processing is involved. Original URLs, MD5
checksums and bundled SHA-256 checksums are pinned in `manifest.json`.

The application reads only these bundled files. It does not call Poly Haven's
API or CDN. Images update six shared canvas textures once on viewport mount;
runway/helipad markings remain part of the existing baked maps. There are no HDR
render targets, reflection captures, displacement maps or additional draw calls.
If a bundled image cannot load, the procedural fallback remains available.

To verify the bundled media without network access:

```sh
python3 tools/prepare_polyhaven_scene.py --check
```

To download the pinned sources and regenerate the JPEGs (requires Pillow):

```sh
python3 tools/prepare_polyhaven_scene.py
```
