# F-35A Lightning II

Author: [shangus930](https://sketchfab.com/shangus930).
Source: [F-35A Lightning II on Sketchfab](https://sketchfab.com/3d-models/f-35a-lightning-ii-a06d6113cfb44a0aa7b8f17106aca9c4).
License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

The user supplied `F-35A_Lightning_II.usdz`. Its embedded USD layer records the
author, source URL and CC-BY-4.0 license above. The original download is unchanged.

Changes: baked skeletal animation and mesh transforms at USD frame 875 (landing
gear down); oriented the nose along -Z; centred X/Z; put the lowest tyre at Y=0;
restored the overall length to 15.7 metres from the AR-normalized source scale;
flipped UV V coordinates for glTF; packed roughness into green and metallic into
blue; embedded the original colour/normal textures and packed PBR textures.
The static GLB has 190514 triangles, nine material batches and 25 embedded maps.
The scene renderer supplies a neutral, locally generated PBR light probe for
this aircraft's reflective materials; no network lighting assets are used.
Measured bounds after conversion: 10.954 × 4.547 × 15.7 m. It is a visual asset,
not dimensionally verified engineering CAD or a flight dynamics model.

Rebuild with `usd-core`, NumPy and Pillow installed:

```sh
python3 scripts/convert-f35a-usdz.py /path/to/F-35A_Lightning_II.usdz client/public/aircraft/f35a
```

`visual-model.json` records the source SHA-256, attribution, baked frame,
dimensions, counts and conversion steps. `f35a.glb` is self-contained, contains
no external URLs or required compression extensions, and may also be imported
through the existing GLB/glTF scene editor.
