import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { Triple } from './sceneDocument';

/** One closed 22 × 16 m shell for both rendering and the exported collision mesh. */
export function createHangarGeometry() {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  function face(points: Triple[], tile: number, coords: [number, number][]) {
    const first = positions.length / 3;
    for (const [i, point] of points.entries()) {
      positions.push(...point);
      const [u, v] = coords[i];
      // Inset the UVs to avoid sampling a neighbouring panel at its seam.
      uvs.push(tile % 2 * .5 + .002 + u * .496, .5 - Math.floor(tile / 2) * .5 + .002 + v * .496);
    }
    indices.push(first, first + 1, first + 2);
    if (points.length === 4) indices.push(first, first + 2, first + 3);
  }
  const rect: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const gable: [number, number][] = [[0, .3], [1, .3], [.5, .7]];
  const x = 11, z = 8, eave = 6.15, ridge = 8;
  face([[-x,0,z], [x,0,z], [x,eave,z], [-x,eave,z]], 0, rect);
  face([[x,0,-z], [-x,0,-z], [-x,eave,-z], [x,eave,-z]], 3, rect);
  face([[x,0,z], [x,0,-z], [x,eave,-z], [x,eave,z]], 1, rect);
  face([[-x,0,-z], [-x,0,z], [-x,eave,z], [-x,eave,-z]], 1, rect);
  face([[-x,eave,z], [x,eave,z], [0,ridge,z]], 3, gable);
  face([[x,eave,-z], [-x,eave,-z], [0,ridge,-z]], 3, gable);
  face([[-x,eave,-z], [-x,eave,z], [0,ridge,z], [0,ridge,-z]], 2, rect);
  face([[x,eave,z], [x,eave,-z], [0,ridge,-z], [0,ridge,z]], 2, rect);
  face([[-x,0,-z], [x,0,-z], [x,0,z], [-x,0,z]], 3, rect);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}
