import { BufferGeometry, Color, Float32BufferAttribute, Vector3, type MeshLambertMaterial } from 'three';

// Each crown is a fixed mesh of twig sprays on branching wood. Instancing these
// four meshes preserves parallax from ground level through a vertical overflight.
export const TREE_FORMS = [
  { spread: 2.20, height: 7.1, clearTrunk: 2.15, bark: '#645243' },
  { spread: 1.70, height: 7.6, clearTrunk: 1.70, bark: '#bfb9a0' },
  { spread: 2.05, height: 6.9, clearTrunk: 1.65, bark: '#64594a' },
  { spread: 1.90, height: 7.3, clearTrunk: 1.90, bark: '#79634f' },
];

// A leaf spray is thin and transmits light. Both faces use the crown normal,
// so turning the camera cannot reveal individual dark rectangular cards.
export const lightTreeFoliage: MeshLambertMaterial['onBeforeCompile'] = shader => {
  shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', 'normal = normalize(vNormal);');
};

export function createTreeGeometry(form: number) {
  const { spread, height, clearTrunk, bark } = TREE_FORMS[form];
  let state = 137 + form * 97;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = [];
  const crownNormals: [number, Vector3][] = [];
  const wood = new Color(bark), up = new Vector3(0, 1, 0);
  const vertex = (point: Vector3, color: Color, u: number, v: number) => {
    positions.push(point.x, point.y, point.z); colors.push(color.r, color.g, color.b); uvs.push(u, v);
  };
  // Tapered branch rings share vertices along their length. A narrow white
  // strip below the leaf atlas holds two longitudinal bark patterns.
  function branch(points: Vector3[], radii: number[], sides: number) {
    const first = positions.length / 3;
    const axis = points[points.length - 1].clone().sub(points[0]).normalize();
    const tangent = new Vector3(1, 0, 0).cross(axis).normalize();
    const bitangent = axis.clone().cross(tangent);
    points.forEach((point, ring) => {
      for (let j = 0; j < sides; j++) {
        const a = j * 2 * Math.PI / sides, radius = radii[ring];
        const p = point.clone().addScaledVector(tangent, radius * Math.cos(a)).addScaledVector(bitangent, radius * Math.sin(a));
        const barkU = (form === 1 ? .5 : 0) + .01 + .47 * ring / (points.length - 1);
        vertex(p, wood.clone().multiplyScalar(.94 + random() * .17), barkU, .003 + .025 * j / sides);
        if (ring > 0) {
          const a = first + (ring - 1) * sides + j, b = first + (ring - 1) * sides + (j + 1) % sides;
          indices.push(a, b, a + sides, b, b + sides, a + sides);
        }
      }
    });
  }
  const u0 = (form % 2) * .5 + .002, u1 = u0 + .496;
  const v1 = 1 - (Math.floor(form / 2) * 496 + 2) / 1024, v0 = v1 - 492 / 1024;
  function spray(root: Vector3, yaw: number, rise: number, length: number) {
    const axis = new Vector3(Math.cos(yaw), rise, Math.sin(yaw)).normalize().multiplyScalar(length);
    const side = new Vector3().crossVectors(up, axis).normalize();
    side.applyAxisAngle(axis.clone().normalize(), (random() - .5) * 1.9).multiplyScalar(length * (.43 + random() * .14));
    const end = root.clone().add(axis), first = positions.length / 3;
    const light = .80 + .22 * (root.y / height) + .13 * random();
    const tint = new Color(light * .90, light, light * .84);
    vertex(root.clone().sub(side), tint, u0, v0); vertex(root.clone().add(side), tint, u1, v0);
    vertex(end.clone().add(side), tint, u1, v1); vertex(end.clone().sub(side), tint, u0, v1);
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    for (let v = first; v < first + 4; v++) {
      const n = new Vector3().fromArray(positions, 3 * v);
      n.y = (n.y - (height + clearTrunk) * .5) * .63 + 1.5;
      crownNormals.push([v, n.normalize()]);
    }
  }
  const trunkAt = (y: number) => new Vector3(
    (.15 + form * .06) * (Math.sin(y * .83 + form) - Math.sin(form)), y,
    .18 * (Math.cos(y * .78 + form) - Math.cos(form)));
  branch([trunkAt(0), trunkAt(clearTrunk), trunkAt(height * .58), trunkAt(height * .82), trunkAt(height - .75)],
    [.23, .15, .10, .053, .017], 7);

  // Stagger clusters around an irregular ellipsoid. Multiple shoots leave
  // each fork at different elevations, including outward and drooping tips.
  const clusters = 28;
  for (let i = 0; i < clusters; i++) {
    const t = (i + .5) / clusters, yaw = i * 2.39996 + random() * .45;
    const dir = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const taper = form === 1 ? 1.22 - .55 * t : 1;
    const reach = spread * taper * Math.sqrt(1 - (2 * t - 1) ** 2) * (.72 + .25 * random());
    const clusterY = clearTrunk + .75 + t * (height - clearTrunk - 1.25);
    const start = trunkAt(Math.max(clearTrunk - .22, clusterY - 1.15 - random() * .42));
    const knee = start.clone().addScaledVector(dir, reach * .52);
    knee.y += .38 + random() * .24;
    const fork = trunkAt(clusterY).addScaledVector(dir, reach);
    branch([start, knee, fork], [.058 + .022 * (1 - t), .034, .009], 3);
    for (let j = 0; j < 9; j++) {
      const angle = yaw + j * 2.39996 + random() * .52;
      const root = knee.clone().lerp(fork, .35 + .68 * random());
      root.x += .16 * Math.cos(angle); root.z += .16 * Math.sin(angle);
      spray(root, angle, -.61 + 2.1 * random(), .88 + .44 * random());
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.setIndex(indices); geo.computeVertexNormals();
  const normals = geo.getAttribute('normal');
  for (const [index, n] of crownNormals) normals.setXYZ(index, n.x, n.y, n.z);
  geo.computeBoundingSphere();
  return geo;
}
