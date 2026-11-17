import { BoxGeometry, BufferGeometry, CircleGeometry, CylinderGeometry, DataTexture, ExtrudeGeometry, Group,
  Mesh, MeshStandardMaterial, RepeatWrapping, RGBAFormat, Shape, TorusGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import geometry from './voliroTGeometry.json';

export const VOLIRO_T_GEOMETRY = geometry;
export const bodyToVisual = ([x, y, z]: number[]) => new Vector3(y, -z, -x);

// A small local weave keeps both browser rendering and the exported GLB offline.
function carbonMaterial() {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const strand = (Math.floor(x / 4) + Math.floor(y / 4)) % 2;
    const c = 24 + (strand ? x % 4 : y % 4) * 5 + ((x + y) % 2) * 3;
    const i = (y * 32 + x) * 4;
    data.set([c, c + 2, c + 3, 255], i);
  }
  const map = new DataTexture(data, 32, 32, RGBAFormat);
  map.wrapS = map.wrapT = RepeatWrapping; map.repeat.set(5, 5); map.needsUpdate = true;
  return new MeshStandardMaterial({ color: '#a2a8ae', map, roughness: .52, metalness: .22 });
}

export function createVoliroTModel(accent = '#25bbc1') {
  const frame = new Group(); frame.name = 'voliro-t-photo-airframe';
  const carbon = carbonMaterial();
  const black = new MeshStandardMaterial({ color: '#171b20', roughness: .64, metalness: .25 });
  const silver = new MeshStandardMaterial({ color: '#adb4bd', metalness: .8, roughness: .28 });
  const copper = new MeshStandardMaterial({ color: '#b76c39', metalness: .7, roughness: .36 });
  const white = new MeshStandardMaterial({ color: '#d4d5cd', roughness: .55 });
  const red = new MeshStandardMaterial({ color: '#a72f2d', roughness: .6 });
  const yellow = new MeshStandardMaterial({ color: '#dba335', roughness: .6 });
  const batteryGold = new MeshStandardMaterial({ color: '#b79a48', roughness: .56, metalness: .18 });
  const marking = new MeshStandardMaterial({ color: accent, roughness: .6 });
  function mesh(parent: Group, shape: BufferGeometry, material: MeshStandardMaterial, position: number[], name?: string) {
    const item = new Mesh(shape, material); item.position.fromArray(position); if (name) item.name = name;
    parent.add(item); return item;
  }
  function box(parent: Group, size: number[], position: number[], material = black) {
    return mesh(parent, new BoxGeometry(...size as [number, number, number]), material, position);
  }
  function tube(parent: Group, a: Vector3, b: Vector3, radius: number, material = carbon, segments = 8) {
    const delta = b.clone().sub(a);
    const item = mesh(parent, new CylinderGeometry(radius, radius, delta.length(), segments), material, a.clone().add(b).multiplyScalar(.5).toArray());
    item.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), delta.normalize()); return item;
  }
  function plate(height: number, y: number, scale = 1) {
    const w = geometry.body.width / 2 * scale, l = geometry.body.length / 2 * scale;
    const outline = new Shape();
    const points = [[-w * .38, -l], [w * .38, -l], [w, -l * .45], [w, l * .58], [w * .66, l], [-w * .66, l], [-w, l * .58], [-w, -l * .45]];
    points.forEach(([x, z], i) => i ? outline.lineTo(x, z) : outline.moveTo(x, z)); outline.closePath();
    // Extrusion's +Z becomes scene +Y; its shape +Y becomes scene -Z.
    const item = mesh(frame, new ExtrudeGeometry(outline, { depth: height, bevelEnabled: false }), carbon, [0, y, -geometry.body.centerBodyX]);
    item.rotation.x = -Math.PI / 2; return item;
  }
  const g = geometry;
  plate(g.body.height - .006, -g.body.height / 2, .96); plate(.003, g.body.height / 2); plate(.003, -g.body.height / 2 - .003);
  // The pack is fixed to the fuselage, not to the rotating cross-tube/pods.
  // Front face coincides with the cross-tube centreline; the pack extends aft.
  const pack = g.battery;
  const battery = new Group(); battery.name = 'voliro-t-battery';
  battery.position.copy(bodyToVisual([
    g.frontBodyX - pack.length / 2, 0,
    g.body.height / 2 + .003 + pack.mountClearance + pack.height / 2,
  ]));
  battery.userData = { model: pack.model, labelMassKg: pack.labelMassKg, alignment: pack.alignment };
  frame.add(battery);
  const packBody = new Group(); packBody.name = 'voliro-t-battery-pack'; battery.add(packBody);
  box(packBody, [pack.width, pack.height, pack.length], [0, 0, 0]);
  // Gold side labels and two retaining straps keep the underside pack distinct.
  for (const side of [-1, 1]) {
    box(battery, [.0006, pack.height * .67, pack.length * .8], [side * (pack.width / 2 + .0003), .002, 0], batteryGold);
  }
  for (const z of [-pack.length * .29, pack.length * .29]) {
    box(battery, [pack.width + .004, .002, .012], [0, -pack.height / 2 - .001, z]);
    for (const side of [-1, 1]) {
      box(battery, [.002, pack.height + .006, .012], [side * (pack.width / 2 + .001), .001, z]);
    }
  }
  tube(battery, new Vector3(.018, .014, -pack.length / 2), new Vector3(.024, .036, -pack.length / 2 - .012), .002, red, 6);
  tube(battery, new Vector3(.011, .014, -pack.length / 2), new Vector3(.018, .036, -pack.length / 2 - .012), .002, black, 6);
  box(battery, [.012, .011, .013], [.021, .038, -pack.length / 2 - .012], yellow);
  tube(frame, new Vector3(-g.halfSpan, 0, -g.frontBodyX), new Vector3(g.halfSpan, 0, -g.frontBodyX), g.crossTubeDiameter / 2);
  tube(frame, new Vector3(0, 0, -.03), new Vector3(0, 0, -g.tailBodyX), g.tailTubeDiameter / 2);
  for (const x of [-.104, .104]) {
    const collar = mesh(frame, new CylinderGeometry(.023, .023, .025, 12), black, [x, 0, -g.frontBodyX]); collar.rotation.z = Math.PI / 2;
  }
  for (const x of [-.066, .066]) for (const z of [-.14, -.105, -.07, .005, .04]) {
    const slot = box(frame, [.039, .001, .006], [x * .6, .044, z]); slot.rotation.y = -.23;
  }
  for (const x of [-.081, .081]) for (const z of [-.155, -.075, .01]) {
    mesh(frame, new CylinderGeometry(.004, .004, .002, 8), silver, [x, .044, z]);
  }
  // Photo landmarks: silver flight-controller housing, GPS puck/mast and straps.
  box(frame, [.045, .024, .043], [-.018, .057, -.08], white);
  mesh(frame, new CylinderGeometry(.015, .015, .002, 16), black, [-.018, .070, -.08]);
  for (let i = 0; i < 6; i++) {
    const vent = box(frame, [.025, .001, .002], [-.018, .0715, -.09 + i * .004]); vent.rotation.y = .3;
  }
  tube(frame, new Vector3(.028, .044, -.015), new Vector3(.028, .125, -.015), .0035, black);
  mesh(frame, new CylinderGeometry(.029, .027, .008, 12), black, [.028, .13, -.015]);
  box(frame, [.008, .003, .055], [-.051, .046, .012]);
  box(frame, [.064, .004, .012], [.008, .046, -.17]);
  box(frame, [.037, .003, .009], [0, .047, -.19], marking);
  tube(frame, new Vector3(.045, .052, -.105), new Vector3(.075, .064, -.14), .002, yellow, 6);
  tube(frame, new Vector3(-.037, .047, .025), new Vector3(.038, .05, -.12), .0013, red, 6);
  tube(frame, new Vector3(-.035, .048, .027), new Vector3(.04, .051, -.12), .0013, black, 6);
  tube(frame, new Vector3(.055, .046, -.045), new Vector3(.065, .14, -.035), .0008, black, 6);
  for (let i = 0; i < 3; i++) {
    const a = bodyToVisual(g.gear.attachmentsBody[i]), b = bodyToVisual(g.gear.contactsBody[i]);
    // End-cap projection must end at the contact plane even on splayed legs.
    const direction = b.clone().sub(a).normalize(), radius = g.gear.diameter * .57;
    const capDrop = radius * Math.sqrt(Math.max(0, 1 - direction.y * direction.y));
    const end = b.clone().addScaledVector(direction, -capDrop / Math.abs(direction.y));
    tube(frame, a, end, g.gear.diameter / 2);
    tube(frame, end.clone().lerp(a, .08), end, radius, black);
    box(frame, [.034, .034, .035], a.toArray());
  }
  // Fixed reversible tail motor: three-blade propeller supplied by live renderer.
  box(frame, [.032, .028, .044], [0, -.006, -g.tailBodyX], silver);
  mesh(frame, new CylinderGeometry(.016, .016, .018, 16), black, [0, .018, -g.tailBodyX]);
  mesh(frame, new CylinderGeometry(.012, .012, .003, 16), copper, [0, .029, -g.tailBodyX]);

  const pods = [-1, 1].map(side => {
    const group = new Group(); group.name = side > 0 ? 'voliro-right-coaxial-pod' : 'voliro-left-coaxial-pod';
    box(group, [.043, .082, .045], [0, 0, 0]);
    for (const sign of [-1, 1]) {
      const y = sign * (g.coaxialSpacing / 2 - .017);
      mesh(group, new CylinderGeometry(g.motorDiameter / 2, g.motorDiameter / 2, g.motorHeight, 12), black, [0, y, 0]);
      const winding = mesh(group, new CircleGeometry(.029, 12), copper, [0, y + sign * .0145, 0]);
      winding.rotation.x = -sign * Math.PI / 2;
      for (let j = 0; j < 6; j++) {
        const angle = j * Math.PI / 3;
        const spoke = box(group, [.031, .0025, .003], [.016 * Math.cos(angle), y + sign * .015, .016 * Math.sin(angle)], silver);
        spoke.rotation.y = -angle;
      }
      const ring = mesh(group, new TorusGeometry(.033, .0018, 3, 12), silver, [0, y + sign * .015, 0]); ring.rotation.x = Math.PI / 2;
    }
    box(group, [.044, .037, .012], [0, -.005, .032]);
    tube(group, new Vector3(.025, .033, .014), new Vector3(.031, -.027, .031), .002, red, 6);
    tube(group, new Vector3(-.025, .033, .014), new Vector3(-.031, -.027, .031), .002, black, 6);
    return group;
  });
  // Merge static pieces by material per assembly; moving pods remain independent.
  function batch(root: Group) {
    root.updateMatrixWorld(true);
    const batches = new Map<MeshStandardMaterial, BufferGeometry[]>();
    for (const object of [...root.children]) if (object instanceof Mesh) {
      const material = object.material as MeshStandardMaterial;
      if (!batches.has(material)) batches.set(material, []);
      // Extruded plates are non-indexed; primitives are indexed. Normalize both.
      const copy = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
      batches.get(material)!.push(copy.applyMatrix4(object.matrix));
      object.geometry.dispose(); root.remove(object);
    }
    for (const [material, parts] of batches) {
      const combined = mergeGeometries(parts); parts.forEach(part => part.dispose());
      if (combined) root.add(new Mesh(combined, material));
    }
  }
  [frame, ...pods, battery].forEach(batch);
  const materials = [carbon, black, silver, copper, white, red, yellow, batteryGold, marking];
  return { frame, pods, dispose() {
    [frame, ...pods].forEach(root => root.traverse(object => { if (object instanceof Mesh) object.geometry.dispose(); }));
    materials.forEach(material => material.dispose()); carbon.map?.dispose();
  } };
}
