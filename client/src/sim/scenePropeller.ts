import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Path, Shape } from 'three';

/** Lofted, swept blade. Outline is a drawing-based approximation; pitch is nominal.
 * Geometry lies radially along +X, with local +Y as the positive thrust axis.
 * handedness=+1 is CCW from above (+Y); -1 mirrors the CW blade.
 * This mesh does not claim a measured airfoil or provide propulsion physics.
 */
export function createPropellerBlade(radius: number, pitch: number, handedness = 1) {
  const stations = [
    [.035, .035, 0], [.09, .052, -.003], [.23, .12, -.012],
    [.43, .17, -.023], [.65, .155, -.023], [.84, .105, -.015],
    [.965, .055, -.005], [1, .005, 0],
  ];
  const vertices: number[] = [], indices: number[] = [];
  const columns = 3, layerSize = stations.length * columns;
  for (const side of [1, -1]) for (const [r, chord, sweep] of stations) {
    // Root blends into the 4.8 mm mounting boss, outside the central 6 mm hole.
    const beta = Math.atan(pitch / (2 * Math.PI * Math.max(radius * r, radius * .18)))
      * Math.min(1, Math.max(0, (r - .035) / .10));
    for (const fraction of [-.5, 0, .5]) {
      const z = fraction * chord * radius;
      const camber = radius * .006 * (1 - 4 * fraction * fraction) * Math.sin(Math.PI * r);
      const thickness = radius * (.002 + .006 * (1 - r)) * (fraction === 0 ? 1 : .3);
      vertices.push(radius * r, -handedness * z * Math.sin(beta) + camber + side * thickness / 2,
        handedness * sweep * radius + z * Math.cos(beta));
    }
  }
  function quad(a: number, b: number, c: number, d: number) { indices.push(a, b, c, a, c, d); }
  for (let row = 0; row < stations.length - 1; row++) for (let col = 0; col < columns - 1; col++) {
    const a = row * columns + col, b = a + columns;
    quad(a, a + 1, b + 1, b); // outward top (+Y)
    quad(a + layerSize, b + layerSize, b + 1 + layerSize, a + 1 + layerSize);
  }
  for (let row = 0; row < stations.length - 1; row++) {
    const a = row * columns, b = a + columns;
    quad(a, b, b + layerSize, a + layerSize);
    quad(a + 2, a + 2 + layerSize, b + 2 + layerSize, b + 2);
  }
  quad(0, layerSize, layerSize + 2, 2);
  const tip = (stations.length - 1) * columns;
  quad(tip, tip + 2, tip + 2 + layerSize, tip + layerSize);
  const result = new BufferGeometry();
  result.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  result.setIndex(indices); result.computeVertexNormals(); result.computeBoundingBox(); result.computeBoundingSphere();
  return result;
}

/** Visible mounting boss; 6 mm through-hole on the MSC front propeller. */
export function createPropellerHub(radius: number, thickness: number, holeRadius: number) {
  const shape = new Shape(); shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  const hole = new Path(); hole.absarc(0, 0, holeRadius, 0, Math.PI * 2, true); shape.holes.push(hole);
  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 6 });
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, -thickness / 2, 0);
  return geometry;
}
