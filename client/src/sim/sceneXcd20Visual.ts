import { BoxGeometry, BufferGeometry, CircleGeometry, Color, CylinderGeometry, Group, InstancedMesh,
  Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createPropellerBlade, createPropellerHub } from './scenePropeller';
import { XCD20_GEOMETRY as g, XCD20_ROTORS } from './sceneXcd20';

/** Dimensioned X8 airframe. Unmeasured battery Z, payload and body details are visual estimates. */
export function createXcd20Model(accent = '#159fd0') {
  const root = new Group(); root.name = 'xcd20-airframe';
  root.userData = { model: 'XCD20', units: 'metres', geometryVersion: g.version,
    diagonalWheelbase: g.diagonalWheelbase, rotorPlaneSpacing: g.rotorPlaneSpacing,
    batteryDimensionsBody: g.batteryDimensionsBody, limitations: g.limitations };
  const materials = {
    carbon: new MeshStandardMaterial({ color: '#272d36', roughness: .76, metalness: .12 }),
    dark: new MeshStandardMaterial({ color: '#394250', roughness: .67, metalness: .3 }),
    silver: new MeshStandardMaterial({ color: '#b4bbc4', roughness: .32, metalness: .78 }),
    blue: new MeshStandardMaterial({ color: accent, roughness: .45, metalness: .42 }),
    pink: new MeshStandardMaterial({ color: '#cd748b', roughness: .75 }),
    green: new MeshStandardMaterial({ color: '#5da73d', roughness: .47, metalness: .14 }),
    lens: new MeshStandardMaterial({ color: '#18313d', roughness: .12, metalness: .57 }),
    pcb: new MeshStandardMaterial({ color: '#267754', roughness: .7 }),
  };
  const geometries = new Set<BufferGeometry>();
  const ownedMaterials = new Set<MeshStandardMaterial | MeshBasicMaterial>(Object.values(materials));
  const batches = new Map<MeshStandardMaterial, BufferGeometry[]>();
  const up = new Vector3(0, 1, 0);
  function add(geometry: BufferGeometry, material: MeshStandardMaterial, p: number[], axis?: Vector3) {
    const temp = new Mesh(geometry); temp.position.fromArray(p);
    if (axis) temp.quaternion.setFromUnitVectors(up, axis);
    temp.updateMatrix(); geometry.applyMatrix4(temp.matrix);
    const list = batches.get(material) ?? []; list.push(geometry); batches.set(material, list);
  }
  function box(size: number[], p: number[], material: MeshStandardMaterial) {
    add(new BoxGeometry(size[0], size[1], size[2]), material, p);
  }
  function cylinder(radius: number, height: number, p: number[], material: MeshStandardMaterial, axis = up) {
    add(new CylinderGeometry(radius, radius, height, 20), material, p, axis);
  }
  function rod(a: number[], b: number[], radius: number, material: MeshStandardMaterial) {
    const start = new Vector3().fromArray(a), end = new Vector3().fromArray(b);
    const direction = end.clone().sub(start);
    cylinder(radius, direction.length(), start.add(end).multiplyScalar(.5).toArray(), material, direction.normalize());
  }
  const bodySize = g.visual.frame_plate_dimensions_body_m;
  for (const y of [-.013, .013]) box([bodySize[1], bodySize[2], bodySize[0]], [0, y, 0], materials.carbon);
  for (const r of XCD20_ROTORS.filter(r => r.channel < 4)) {
    rod([0, 0, 0], [r.x, 0, r.z], .014, materials.blue);
    box([.075, .012, .070], [r.x, 0, r.z], materials.dark);
  }
  const motorRadius = g.visual.motor_body_diameter_m / 2, motorHeight = g.visual.motor_body_height_m;
  for (const r of XCD20_ROTORS) {
    const side = Math.sign(r.y);
    const center = r.y - side * (motorHeight / 2 + g.visual.motor_adapter_height_m);
    cylinder(motorRadius, motorHeight, [r.x, center, r.z], materials.dark);
    cylinder(motorRadius * 1.02, .009, [r.x, center + side * .016, r.z], materials.silver);
    cylinder(motorRadius * .84, .019, [r.x, center - side * .002, r.z], materials.blue);
    cylinder(.006, .014, [r.x, r.y - side * .004, r.z], materials.silver);
  }
  const batteryBody = g.visual.battery_center_body_m;
  const batteryPosition = [batteryBody[1], -batteryBody[2], -batteryBody[0]];
  box([g.batteryDimensionsBody[1], g.batteryDimensionsBody[2], g.batteryDimensionsBody[0]], batteryPosition, materials.pink);
  for (const z of [-.06, .06]) box([g.batteryDimensionsBody[1] + .004, .004, .014],
    [batteryPosition[0], batteryPosition[1] + g.batteryDimensionsBody[2] / 2 + .002, batteryPosition[2] + z], materials.carbon);
  const battery = new Group(); battery.name = 'xcd20-battery-reference'; battery.position.fromArray(batteryPosition);
  battery.userData = { dimensionsBodyM: g.batteryDimensionsBody, positionStatus: g.visual.battery_center_status }; root.add(battery);
  box([.045, .008, .045], [0, .025, -.112], materials.pcb);
  cylinder(.021, .007, [0, .036, .115], materials.silver);
  box([.06, .005, .012], [0, .021, -.146], materials.blue);

  // Fixed landing frame and green reference payload follow the supplied side view.
  const skidY = -g.groundClearance + .008;
  for (const x of [-.15, .15]) {
    rod([x, skidY, -.19], [x, skidY, .19], .008, materials.carbon);
    for (const z of [-.13, .13]) rod([x * .72, -.015, z * .7], [x, skidY, z], .006, materials.carbon);
  }
  const payload = g.visual.reference_payload;
  if (payload.visible) {
    const p = [payload.center_body_m[1], -payload.center_body_m[2], -payload.center_body_m[0]];
    add(new SphereGeometry(payload.radius_m, 28, 16), materials.green, p);
    rod([-.075, -.02, 0], [-.075, p[1], 0], .007, materials.dark);
    rod([.075, -.02, 0], [.075, p[1], 0], .007, materials.dark);
    cylinder(payload.radius_m * .53, .012, [p[0], p[1], p[2] - payload.radius_m * .86], materials.lens, new Vector3(0, 0, -1));
    const reference = new Group(); reference.name = 'xcd20-payload-reference'; reference.position.fromArray(p);
    reference.userData = { status: payload.status }; root.add(reference);
  }
  for (const [material, parts] of batches) {
    const merged = mergeGeometries(parts); parts.forEach(part => part.dispose());
    if (!merged) throw new Error('XCD20 static geometry merge failed');
    geometries.add(merged); const mesh = new Mesh(merged, material); mesh.castShadow = true; root.add(mesh);
  }
  const bladeMaterial = new MeshStandardMaterial({ color: '#ffffff', roughness: .68, metalness: .08 });
  const hubMaterial = new MeshStandardMaterial({ color: '#454d59', roughness: .56, metalness: .25 });
  ownedMaterials.add(bladeMaterial); ownedMaterials.add(hubMaterial);
  const blades = new Map<number, BufferGeometry>();
  for (const handedness of [-1, 1]) { const geometry = createPropellerBlade(g.rotorRadius, g.propellerPitch, handedness); blades.set(handedness, geometry); geometries.add(geometry); }
  const hub = createPropellerHub(.01375, .008, .003); geometries.add(hub);
  const diskGeometry = new CircleGeometry(g.rotorRadius, 40); geometries.add(diskGeometry);
  const rotors: Group[] = [], blurDisks: Mesh<CircleGeometry, MeshBasicMaterial>[] = [];
  for (const r of XCD20_ROTORS) {
    const station = new Group(); station.name = `xcd20-station-${r.channel}`; station.position.set(r.x, r.y, r.z); root.add(station);
    station.userData = { channel: r.channel, bodyPositionM: r.body_position_m, pair: r.paired_channel };
    const spinner = new Group(); spinner.name = `xcd20-rotor-${r.channel}`;
    spinner.rotation.y = r.channel >= 4 ? Math.PI / 3 : 0;
    spinner.userData = { channel: r.channel, blades: g.blades, propellerSense: r.sense };
    const mesh = new InstancedMesh(blades.get(r.sense)!, bladeMaterial, g.blades);
    for (let blade = 0; blade < g.blades; blade++) {
      mesh.setMatrixAt(blade, new Matrix4().makeRotationY(blade * Math.PI * 2 / g.blades));
      mesh.setColorAt(blade, new Color(blade === 0 ? '#a6ad9b' : '#555d6a'));
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true; mesh.computeBoundingSphere();
    spinner.add(mesh, new Mesh(hub, hubMaterial)); station.add(spinner); rotors.push(spinner);
    const material = new MeshBasicMaterial({ color: '#c2cad2', transparent: true, opacity: 0, depthWrite: false, side: 2 }); ownedMaterials.add(material);
    const disk = new Mesh(diskGeometry, material); disk.rotation.x = -Math.PI / 2; disk.visible = false; station.add(disk); blurDisks.push(disk);
  }
  return { root, rotors, blurDisks, dispose() { geometries.forEach(geometry => geometry.dispose()); ownedMaterials.forEach(material => material.dispose()); } };
}
