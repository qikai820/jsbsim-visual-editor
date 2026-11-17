#!/usr/bin/env python3
"""Convert the supplied Sketchfab F-35A USDZ to a self-contained static GLB.

Requires usd-core, numpy and Pillow. Bakes the final animation frame (gear down),
preserves authored normals/UVs and PreviewSurface PBR maps, and restores a 15.7 m
aircraft length because the AR asset was normalized for display, not real scale.
This deliberately validates this asset's triangle/vertex layout rather than
pretending to be a general-purpose USD converter.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import zipfile

import numpy as np
from PIL import Image
from pxr import Gf, Usd, UsdGeom, UsdShade, UsdSkel


def convert(source: Path, output: Path):
    stage = Usd.Stage.Open(str(source))
    if not stage or UsdGeom.GetStageUpAxis(stage) != 'Y':
        raise ValueError('Expected the supplied Y-up F-35A USDZ')
    credit = dict(stage.GetRootLayer().customLayerData)
    frame = stage.GetEndTimeCode()
    # Work in memory; never modify the user's source file or its USD layers.
    stage.SetEditTarget(stage.GetSessionLayer())
    if not UsdSkel.BakeSkinning(stage.Traverse(), Gf.Interval(frame, frame)):
        raise ValueError('Unable to bake the parked pose')
    time = Usd.TimeCode(frame)
    transforms = UsdGeom.XformCache(time)
    parts = []
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Mesh) or UsdGeom.Imageable(prim).ComputeVisibility(time) == 'invisible':
            continue
        mesh = UsdGeom.Mesh(prim)
        if set(mesh.GetFaceVertexCountsAttr().Get(time)) != {3}:
            raise ValueError(f'Non-triangle mesh: {prim.GetPath()}')
        vertices = np.asarray(mesh.GetPointsAttr().Get(time), dtype=np.float64)
        normals = np.asarray(mesh.GetNormalsAttr().Get(time), dtype=np.float64)
        uv = UsdGeom.PrimvarsAPI(prim).GetPrimvar('st0')
        if mesh.GetNormalsInterpolation() != 'vertex' or not uv or uv.GetInterpolation() != 'vertex':
            raise ValueError(f'Unexpected normal/UV interpolation: {prim.GetPath()}')
        texcoords = np.asarray(uv.ComputeFlattened(time), dtype=np.float32).copy()
        if len(normals) != len(vertices) or len(texcoords) != len(vertices):
            raise ValueError('Attribute counts do not match')
        matrix = np.asarray(transforms.GetLocalToWorldTransform(prim))
        vertices = (np.c_[vertices, np.ones(len(vertices))] @ matrix)[:, :3]
        normals = normals @ np.linalg.inv(matrix[:3, :3]).T
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-20)
        indices = np.asarray(mesh.GetFaceVertexIndicesAttr().Get(time), dtype=np.uint32).reshape(-1, 3).copy()
        if (np.linalg.det(matrix[:3, :3]) < 0) != (mesh.GetOrientationAttr().Get() == 'leftHanded'):
            indices = indices[:, [0, 2, 1]]
        # USD images use bottom-left texture coordinates; glTF uses top-left.
        texcoords[:, 1] = 1 - texcoords[:, 1]
        # Source faces +Z; the editor's aircraft convention faces -Z.
        vertices[:, [0, 2]] *= -1
        normals[:, [0, 2]] *= -1
        # Read the authored relation without mutating schemas on the input.
        targets = prim.GetRelationship('material:binding').GetTargets()
        if len(targets) != 1:
            raise ValueError(f'Unexpected material binding: {prim.GetPath()}')
        parts.append(dict(name=prim.GetName(), vertices=vertices, normals=normals,
                          uv=texcoords, indices=indices, material=str(targets[0]),
                          double=bool(mesh.GetDoubleSidedAttr().Get())))
    low = np.min([p['vertices'].min(0) for p in parts], axis=0)
    high = np.max([p['vertices'].max(0) for p in parts], axis=0)
    scale = 15.7 / (high[2] - low[2])
    origin = np.array([(low[0] + high[0]) / 2, low[1], (low[2] + high[2]) / 2])
    for part in parts:
        part['vertices'] = ((part['vertices'] - origin) * scale).astype('<f4')

    gltf = dict(asset={'version': '2.0', 'generator': 'JSBSim F-35A USDZ conversion',
                       'copyright': f"{credit.get('author', '')} · {credit.get('copyright', '')}"},
                scene=0, scenes=[{'nodes': [0]}], nodes=[{'name': 'scene-f35-airframe', 'mesh': 0}],
                meshes=[], materials=[], accessors=[], bufferViews=[], buffers=[], images=[],
                textures=[], samplers=[{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}])
    binary = bytearray()

    def view(data, target=None):
        binary.extend(b'\0' * ((-len(binary)) % 4))
        item = {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data)}
        if target:
            item['target'] = target
        gltf['bufferViews'].append(item)
        binary.extend(data)
        return len(gltf['bufferViews']) - 1

    def accessor(array, kind, component=5126, bounds=False):
        array = np.ascontiguousarray(array)
        item = dict(bufferView=view(array.tobytes(), 34963 if kind == 'SCALAR' else 34962),
                    componentType=component, count=len(array), type=kind)
        if bounds:
            item.update(min=array.min(0).tolist(), max=array.max(0).tolist())
        gltf['accessors'].append(item)
        return len(gltf['accessors']) - 1

    archive = zipfile.ZipFile(source)
    image_cache = {}

    def texture(key, data, mime):
        if key not in image_cache:
            image = len(gltf['images'])
            gltf['images'].append(dict(name=key, bufferView=view(data), mimeType=mime))
            gltf['textures'].append(dict(source=image, sampler=0))
            image_cache[key] = len(gltf['textures']) - 1
        return {'index': image_cache[key]}

    def connected_texture(shader, name):
        inp = shader.GetInput(name)
        link = inp.GetConnectedSource() if inp else None
        if not link:
            return None
        tex = UsdShade.Shader(link[0].GetPrim())
        if tex.GetIdAttr().Get() != 'UsdUVTexture':
            raise ValueError(f'Unsupported texture network: {name}')
        return tex.GetInput('file').Get().path

    def scalar(shader, name, fallback):
        attr = shader.GetInput(name)
        value = attr.Get() if attr else None
        return float(value) if value is not None else fallback

    primitives = []
    groups = {}
    for part in parts:
        groups.setdefault((part['material'], part['double']), []).append(part)
    for (material_path, double), group in groups.items():
        shader = UsdShade.Material(stage.GetPrimAtPath(material_path)).ComputeSurfaceSource()[0]
        pbr = dict(metallicFactor=scalar(shader, 'metallic', 1 if connected_texture(shader, 'metallic') else 0),
                   roughnessFactor=scalar(shader, 'roughness', 1 if connected_texture(shader, 'roughness') else .5))
        material = dict(name=material_path.rsplit('/', 1)[-1], pbrMetallicRoughness=pbr, doubleSided=double)
        base = connected_texture(shader, 'diffuseColor')
        if base:
            pbr['baseColorTexture'] = texture(base, archive.read(base), 'image/png' if base.endswith('.png') else 'image/jpeg')
        else:
            colour = shader.GetInput('diffuseColor').Get()
            pbr['baseColorFactor'] = list(colour or (1, 1, 1)) + [scalar(shader, 'opacity', 1)]
        if shader.GetInput('opacity'):
            material['alphaMode'] = 'BLEND'
            if not shader.GetInput('opacity').GetConnectedSource():
                pbr.setdefault('baseColorFactor', [1, 1, 1, 1])[3] = scalar(shader, 'opacity', 1)
        normal = connected_texture(shader, 'normal')
        if normal:
            material['normalTexture'] = texture(normal, archive.read(normal), 'image/jpeg')
        metal, rough = connected_texture(shader, 'metallic'), connected_texture(shader, 'roughness')
        if metal or rough:
            def channel(path, value, size):
                if not path:
                    return Image.new('L', size, round(value * 255))
                return Image.open(io.BytesIO(archive.read(path))).convert('RGB').getchannel('R').resize(size)
            size = Image.open(io.BytesIO(archive.read(rough or metal))).size
            packed = Image.merge('RGB', [Image.new('L', size, 255), channel(rough, pbr['roughnessFactor'], size), channel(metal, pbr['metallicFactor'], size)])
            data = io.BytesIO(); packed.save(data, format='PNG', optimize=True)
            pbr['metallicRoughnessTexture'] = texture(material['name'] + '_metallicRoughness.png', data.getvalue(), 'image/png')
        index = len(gltf['materials']); gltf['materials'].append(material)
        offset = 0; indices = []
        for part in group:
            indices.append(part['indices'].reshape(-1) + offset)
            offset += len(part['vertices'])
        vertices = np.concatenate([p['vertices'] for p in group])
        normals = np.concatenate([p['normals'] for p in group]).astype('<f4')
        texcoords = np.concatenate([p['uv'] for p in group]).astype('<f4')
        primitive = dict(attributes={'POSITION': accessor(vertices, 'VEC3', bounds=True),
                                     'NORMAL': accessor(normals, 'VEC3'), 'TEXCOORD_0': accessor(texcoords, 'VEC2')},
                         indices=accessor(np.concatenate(indices).astype('<u4'), 'SCALAR', 5125), material=index)
        primitives.append(primitive)
    triangles = sum(len(p['indices']) for p in parts)
    size = ((high - low) * scale).tolist()
    metadata = dict(title=credit.get('title'), author=credit.get('author'), license=credit.get('copyright'),
                    sourceUrl=credit.get('url'), sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                    sourceFile=source.name, asset='f35a.glb', units='m', axes='+X right, +Y up, -Z nose',
                    pose='Final USD animation frame, landing gear down', sourceFrame=frame,
                    lengthM=15.7, sizeM=size, bounds={'min': ((low-origin)*scale).tolist(), 'max': ((high-origin)*scale).tolist()},
                    triangles=triangles, materials=len(gltf['materials']), textures=len(gltf['textures']),
                    conversion='Skinning and transforms baked; real length restored; UV V flipped; metallic/roughness packed; original colour/normal maps embedded')
    gltf['nodes'][0]['extras'] = metadata
    gltf['meshes'] = [{'name': 'F-35A Lightning II · shangus930', 'primitives': primitives}]
    binary.extend(b'\0' * ((-len(binary)) % 4)); gltf['buffers'] = [{'byteLength': len(binary)}]
    text = json.dumps(gltf, separators=(',', ':')).encode(); text += b' ' * ((-len(text)) % 4)
    result = struct.pack('<III', 0x46546c67, 2, 28 + len(text) + len(binary))
    result += struct.pack('<II', len(text), 0x4e4f534a) + text
    result += struct.pack('<II', len(binary), 0x004e4942) + binary
    output.mkdir(parents=True, exist_ok=True)
    (output / 'f35a.glb').write_bytes(result)
    metadata['bytes'] = len(result)
    (output / 'visual-model.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    convert(args.source.resolve(), args.output.resolve())
