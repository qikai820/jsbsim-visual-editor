import { Box3, BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, RingGeometry, Vector3, type Object3D } from 'three';
import type { PlatformGeometry } from './sceneMovingPlatform';

/** Local right/up/aft axes; the platform origin is the native module's origin. */
export function createMovingPlatformModel(vessel: Object3D, g: PlatformGeometry) {
  const root = new Group(); root.name = 'moving-platform-model';
  const owned: Mesh[] = [];
  const deckY = -g.deckZ;
  const box = (name: string, size: [number, number, number], p: [number, number, number], color: string, metalness = .15) => {
    const mesh = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color, roughness: .72, metalness }));
    mesh.name = name; mesh.position.set(...p); mesh.castShadow = true; mesh.receiveShadow = true;
    root.add(mesh); owned.push(mesh); return mesh;
  };
  const ship = vessel.clone(true); ship.name = 'downloaded-kenney-vessel';
  const bounds = new Box3().setFromObject(ship), size = bounds.getSize(new Vector3()), center = bounds.getCenter(new Vector3());
  // Preserve the downloaded hull shape; put the landing patch on its aft deck.
  const scale = Math.max((g.width + .8) / size.x, (g.length + 5.5) / size.z);
  ship.scale.multiplyScalar(scale);
  ship.rotation.y = Math.PI;
  ship.position.set(center.x * scale, deckY - 1.48 * scale, -g.length * .65);
  root.add(ship);
  const deck = box('landing-deck', [g.width, .12, g.length], [0, deckY - .06, 0], '#244d53');
  // Preview only the physical hull and solid deck. Decorative marks are absent.
  const collision = new Group(); collision.name = 'moving-platform-collision-wire'; collision.visible = false;
  const wireMaterial = new MeshBasicMaterial({ color: '#35f1e1', wireframe: true, transparent: true, opacity: .8,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false });
  for (const shape of [ship, deck]) {
    const wire = shape.clone(true);
    wire.traverse(node => { if (node instanceof Mesh) node.material = wireMaterial; });
    collision.add(wire);
  }
  root.add(collision);
  const line = Math.min(.045, g.width * .025, g.length * .025), inset = line * 2;
  for (const side of [-1, 1]) {
    box('deck-safety-edge', [line, .008, Math.max(.01, g.length - inset)], [side * (g.width / 2 - inset), deckY + .005, 0], '#f6cc63');
    box('deck-safety-edge', [Math.max(.01, g.width - inset), .008, line], [0, deckY + .005, side * (g.length / 2 - inset)], '#f6cc63');
  }
  const radius = Math.min(g.width, g.length) * .29;
  const ring = new Mesh(new RingGeometry(radius * .94, radius, 64), new MeshStandardMaterial({ color: '#ecf6e9', roughness: .8 }));
  ring.name = 'landing-ring'; ring.rotation.x = -Math.PI / 2; ring.position.y = deckY + .012; root.add(ring); owned.push(ring);
  const h = radius * .65;
  for (const side of [-1, 1]) box('helipad-H', [line * 1.4, .008, h * 1.4], [side * h * .35, deckY + .014, 0], '#ecf6e9');
  box('helipad-H', [h * .7, .008, line * 1.4], [0, deckY + .014, 0], '#ecf6e9');
  // The native base is {0, ±spacing/2, -cgZ + sleeve/2} in platform FRD.
  if (g.mode !== 0) for (const side of [-1, 1]) {
    const baseY = g.cgZ - g.sleeve / 2;
    box('rod-base', [.12, .06, .18], [side * g.spacing / 2, baseY - .03, 0], '#263943', .6);
    const rod = new Mesh(new CylinderGeometry(.014, .014, g.rodLength, 12), new MeshStandardMaterial({ color: '#c7d5de', metalness: .8, roughness: .25 }));
    rod.name = side < 0 ? 'guide-rod-left' : 'guide-rod-right';
    rod.position.set(side * g.spacing / 2, baseY + g.rodLength / 2, 0); root.add(rod); owned.push(rod);
    box('rod-tip', [.045, .06, .045], [side * g.spacing / 2, baseY + g.rodLength, 0], '#f6a443');
  }
  Object.assign(root.userData, { geometry: g, source: 'Kenney / Watercraft Kit / CC0-1.0', deckY });
  return { root, collision, dispose() { wireMaterial.dispose(); for (const mesh of owned) { mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); } } };
}
