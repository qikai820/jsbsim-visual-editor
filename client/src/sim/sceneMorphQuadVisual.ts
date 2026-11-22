import { BoxGeometry, BufferGeometry, CatmullRomCurve3, CylinderGeometry, Float32BufferAttribute,
  ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, Path, Shape, TubeGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MORPHQUAD_ARMS, MORPHQUAD_GEOMETRY as g } from './sceneMorphQuad';

/** Photo reconstruction of MorphQuad, paper v5 Figures 4/5 and Table S1.
 * Rotor centres, prop diameter and overall height are published dimensions.
 * Plate outline, ring section, coaxial spacing and equipment sizes are estimates.
 * Assemblies have local origins at their actual pivots: outer Rx(-alpha),
 * inner Rz(-beta), both carrying the rotor pair (scene thrust axis +Y).
 */
export function createMorphQuadModel(accent = '#25bbc1') {
  const frame = new Group(); frame.name = 'morphquad-detailed-airframe';
  const dark = new MeshStandardMaterial({ color: '#25282c', roughness: .77, metalness: .12 });
  const plate = new MeshStandardMaterial({ color: '#35383b', roughness: .86, metalness: .08 });
  const rubber = new MeshStandardMaterial({ color: '#14171a', roughness: .94 });
  const silver = new MeshStandardMaterial({ color: '#a5adb4', roughness: .32, metalness: .78 });
  const copper = new MeshStandardMaterial({ color: '#b7743d', roughness: .4, metalness: .65 });
  const pcb = new MeshStandardMaterial({ color: '#245b43', roughness: .7, metalness: .14 });
  const red = new MeshStandardMaterial({ color: '#ad352b', roughness: .7 });
  const yellow = new MeshStandardMaterial({ color: '#c7a43d', roughness: .68 });
  const blue = new MeshStandardMaterial({ color: '#3c8099', roughness: .68 });
  const lens = new MeshStandardMaterial({ color: '#173c48', roughness: .15, metalness: .55 });
  const marking = new MeshStandardMaterial({ color: accent, roughness: .65 });
  // Vertex colors retain component colors with three surface classes, avoiding
  // one draw per wire color on every independently moving assembly.
  const matteBatch = new MeshStandardMaterial({ vertexColors: true, roughness: .78, metalness: .08 });
  const metalBatch = new MeshStandardMaterial({ vertexColors: true, roughness: .35, metalness: .72 });
  const glossyBatch = new MeshStandardMaterial({ vertexColors: true, roughness: .15, metalness: .55 });
  const materials = [dark, plate, rubber, silver, copper, pcb, red, yellow, blue, lens, marking, matteBatch, metalBatch, glossyBatch];
  const up = new Vector3(0, 1, 0);
  function mesh(parent: Group, geometry: BufferGeometry, material: MeshStandardMaterial, p: number[]) {
    const item = new Mesh(geometry, material); item.position.fromArray(p); parent.add(item); return item;
  }
  function box(parent: Group, size: [number, number, number], p: number[], material = dark) {
    return mesh(parent, new BoxGeometry(...size), material, p);
  }
  function cylinder(parent: Group, r: number, h: number, p: number[], material = silver, axis = up, segments = 12) {
    const item = mesh(parent, new CylinderGeometry(r, r, h, segments), material, p);
    item.quaternion.setFromUnitVectors(up, axis); return item;
  }
  function rod(parent: Group, a: number[], b: number[], r: number, material = dark) {
    const start = new Vector3().fromArray(a), end = new Vector3().fromArray(b), delta = end.clone().sub(start);
    return cylinder(parent, r, delta.length(), start.add(end).multiplyScalar(.5).toArray(), material, delta.normalize(), 8);
  }
  function wire(parent: Group, points: number[][], material = rubber, r = .0011, closed = false) {
    const curve = new CatmullRomCurve3(points.map(p => new Vector3().fromArray(p)), closed, 'centripetal');
    return mesh(parent, new TubeGeometry(curve, points.length * 3, r, 4, closed), material, [0, 0, 0]);
  }
  function washer(parent: Group, outer: number, inner: number, depth: number, p: number[], axis = up, material = silver) {
    const shape = new Shape(); shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
    const hole = new Path(); hole.absarc(0, 0, inner, 0, Math.PI * 2, true); shape.holes.push(hole);
    const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 20 });
    geometry.translate(0, 0, -depth / 2); geometry.rotateX(-Math.PI / 2);
    const item = mesh(parent, geometry, material, p); item.quaternion.setFromUnitVectors(up, axis); return item;
  }
  function bolt(parent: Group, p: number[], axis = up) {
    cylinder(parent, .003, .0018, p, silver, axis, 6);
  }
  // H outline with broad mounting tabs at the front and rear rotor axes.
  for (const y of [g.plateTop, g.plateBottom]) {
    const outline = new Shape();
    const points = [[-.109,-.226],[.109,-.226],[.109,-.158],[.074,-.13],
      [.074,.13],[.109,.158],[.109,.226],[-.109,.226],[-.109,.158],[-.074,.13],[-.074,-.13],[-.109,-.158]];
    points.forEach(([x,z], i) => i ? outline.lineTo(x,z) : outline.moveTo(x,z)); outline.closePath();
    // Extrusion becomes +Y. The outline is symmetric fore/aft.
    const item = mesh(frame, new ExtrudeGeometry(outline, { depth: g.plateThickness, bevelEnabled: false }), plate, [0,y,0]);
    item.rotation.x = -Math.PI / 2;
  }
  for (const x of [-.062,.062]) for (const z of [-.205,-.12,.12,.205]) {
    cylinder(frame, .0035, g.plateTop - g.plateBottom, [x,-.006,z]);
    bolt(frame,[x,g.plateTop + .004,z]); bolt(frame,[x,g.plateBottom - .001,z]);
  }
  // Battery, retaining straps and central power connector.
  box(frame,[.065,.060,.132],[0,.045,0],rubber);
  box(frame,[.066,.042,.104],[0,.045,0],dark);
  for (const z of [-.041,.041]) {
    box(frame,[.071,.002,.012],[0,.076,z],rubber);
    for (const x of [-.035,.035]) box(frame,[.002,.061,.012],[x,.046,z],rubber);
  }
  box(frame,[.013,.010,.014],[.047,.029,.049],yellow);
  wire(frame,[[.025,.045,.066],[.043,.049,.078],[.054,.036,.066],[.047,.029,.049]],red,.002);
  wire(frame,[[.017,.045,.066],[.035,.056,.082],[.05,.038,.067],[.042,.029,.049]],rubber,.002);
  // Rear Jetson PCB, heatsink, fan, USB ports and mounting screws.
  box(frame,[.075,.003,.087],[0,.024,.145],pcb);
  box(frame,[.060,.034,.060],[0,.044,.145]);
  for (let i=0;i<10;i++) box(frame,[.003,.034,.060],[-.027+i*.006,.078,.145]);
  const fanCase = new Shape();
  fanCase.moveTo(-.031,-.031); fanCase.lineTo(.031,-.031); fanCase.lineTo(.031,.031); fanCase.lineTo(-.031,.031); fanCase.closePath();
  const fanHole = new Path(); fanHole.absarc(0,0,.022,0,Math.PI*2,true); fanCase.holes.push(fanHole);
  const fanGeometry = new ExtrudeGeometry(fanCase,{depth:.009,bevelEnabled:false,curveSegments:16});
  fanGeometry.rotateX(-Math.PI/2); mesh(frame,fanGeometry,dark,[0,.095,.145]);
  cylinder(frame,.021,.004,[0,.098,.145],rubber,up,24);
  washer(frame,.024,.021,.004,[0,.103,.145],up,dark);
  cylinder(frame,.007,.002,[0,.102,.145],dark);
  for (let i=0;i<7;i++) {
    const angle=i*Math.PI*2/7;
    const blade=box(frame,[.016,.0015,.005],[Math.cos(angle)*.013,.101, .145+Math.sin(angle)*.013]);
    blade.rotation.y=-angle+.4;
  }
  for (const x of [-.028,.028]) for (const z of [.118,.172]) {
    cylinder(frame,.002,.006,[x,.100,z]); bolt(frame,[x,.103,z]);
  }
  for (const x of [-.022,0,.022]) {
    box(frame,[.017,.013,.016],[x,.033,.194],silver);
    box(frame,[.012,.007,.0007],[x,.033,.2025],rubber);
  }
  // Front flight computer and a second exposed carrier board.
  box(frame,[.085,.003,.072],[0,.022,-.151],pcb);
  box(frame,[.041,.020,.047],[-.015,.034,-.150]);
  box(frame,[.026,.001,.018],[-.015,.0445,-.150],rubber);
  box(frame,[.019,.011,.031],[.028,.029,-.158]);
  for (const x of [-.033,.033]) for (const z of [-.179,-.122]) bolt(frame,[x,.025,z]);
  for (let i=0;i<7;i++) box(frame,[.003,.004,.009],[-.027+i*.009,.026,-.191],silver);
  // Eight independent ESCs protected between the two plates.
  for (const x of [-.046,.046]) for (const z of [-.10,-.04,.04,.10]) {
    box(frame,[.024,.017,.037],[x,-.005,z]);
    for (let i=0;i<3;i++) box(frame,[.024,.002,.002],[x,.004,z-.010+i*.009],silver);
  }
  // VIO tracking camera: forward-facing lens bar underneath the front plate.
  box(frame,[.067,.019,.013],[0,-.043,-.226]);
  for (const x of [-.024,.024]) {
    cylinder(frame,.006,.0015,[x,-.043,-.2335],rubber,new Vector3(0,0,1),20);
    cylinder(frame,.0037,.0016,[x,-.043,-.2345],lens,new Vector3(0,0,1),20);
  }
  box(frame,[.025,.003,.006],[0,.016,-.213],marking);
  // Fore/aft cable looms remain on the airframe; slack at each hollow pivot.
  for (const x of [-.063,.063]) {
    wire(frame,[[x,.020,-.19],[x*.95,.026,-.10],[x*1.08,.026,.03],[x,.022,.18]],red);
    wire(frame,[[x+.003,.021,-.19],[x*.95+.003,.027,-.10],[x*1.08+.003,.027,.03],[x+.003,.022,.18]],yellow,.0008);
    wire(frame,[[x-.003,.021,-.19],[x*.95-.003,.027,-.10],[x*1.08-.003,.027,.03],[x-.003,.022,.18]],blue,.0008);
  }
  // Splayed feet: neutral top at +.105 m, contact at -.205 m -> 310 mm.
  for (const x of [-1,1]) for (const z of [-1,1]) {
    box(frame,[.022,.017,.025],[x*.058,-.026,z*.118]);
    rod(frame,[x*.058,-.026,z*.118],[x*.084,g.footY+.014,z*.152],.0045);
    cylinder(frame,.008,.014,[x*.084,g.footY+.007,z*.152],rubber);
  }
  const rings: Group[] = [], pods: Group[] = [];
  for (const [i,arm] of MORPHQUAD_ARMS.entries()) {
    const side=Math.sign(arm.x), axis=new Vector3(1,0,0);
    const x=arm.x-side*(g.ringOuterRadius+.009), z=arm.z;
    // Fixed outer servo and bearing carrier, with a clear hollow wire route.
    box(frame,[.017,.033,.028],[x,g.gimbalY-.017,z]);
    box(frame,[.024,.024,.023],[x,g.gimbalY-.046,z+.028]);
    washer(frame,.011,.004,.005,[x,g.gimbalY,z],axis);
    cylinder(frame,.007,.006,[x,g.gimbalY-.046,z+.028],dark,axis);
    const beltPoints: number[][]=[];
    for (let j=0;j<12;j++) {
      const a=j*Math.PI*2/12;
      // Closed oblong follows both pulleys; the long portions are straight spans.
      const lower=Math.sin(a)<0;
      beltPoints.push([x-side*.006,g.gimbalY-(lower?.046:0)+Math.sin(a)*(lower?.008:.012),
        z+(lower?.028:0)+Math.cos(a)*(lower?.008:.012)]);
    }
    wire(frame,beltPoints,rubber,.0012,true);
    wire(frame,[[x-side*.01,.025,z-.01],[x-side*.022,.034,z-.03],
      [x-side*.018,.055,z-.024],[x,g.gimbalY,z]],red);
    const ring=new Group(); ring.name=`morphquad-ring-${i}`;
    // One broad thin-walled circular ring, not nested torus gimbals.
    washer(ring,g.ringOuterRadius,g.ringInnerRadius,g.ringHeight,[0,0,0],up,dark);
    for (const sign of [-1,1]) {
      washer(ring,.009,.0036,.005,[sign*(g.ringOuterRadius+.001),0,0],axis);
      box(ring,[.021,.023,.024],[0,0,sign*g.ringOuterRadius]);
      bolt(ring,[0,.013,sign*g.ringOuterRadius]);
    }
    box(ring,[.023,.025,.021],[0,-.001,g.ringOuterRadius+.007]);
    wire(ring,[[-side*(g.ringOuterRadius+.003),0,0],[-side*.075,.012,.055],
      [-side*.035,.013,.088],[0,.014,g.ringOuterRadius]],yellow,.0008);
    wire(ring,[[-side*(g.ringOuterRadius+.003),.003,0],[-side*.073,.015,.055],
      [-side*.033,.016,.088],[0,.017,g.ringOuterRadius]],rubber,.0012);
    const pod=new Group(); pod.name=`morphquad-coaxial-motors-${i}`;
    rod(pod,[0,0,-g.ringInnerRadius],[0,0,g.ringInnerRadius],.0035);
    box(pod,[.034,.010,.040],[0,0,0]);
    for (const sign of [-1,1]) {
      const y=sign*.020;
      cylinder(pod,.018,.021,[0,y,0],dark,up,20);
      washer(pod,.016,.009,.002,[0,sign*.0315,0],up,copper);
      cylinder(pod,.003,.010,[0,sign*.033,0]);
      for(let j=0;j<6;j++) {
        const angle=j*Math.PI/3;
        const spoke=box(pod,[.013,.002,.003],[Math.cos(angle)*.010,sign*.032,Math.sin(angle)*.010]);
        spoke.rotation.y=-angle;
      }
    }
    wire(pod,[[.012,0,0],[.015,.004,.032],[.008,.006,.062],[0,0,g.ringInnerRadius]],red);
    rings.push(ring); pods.push(pod);
  }
  // Batch only within a rigid assembly: animated pivots remain separate.
  // No runtime textures or network resources; each assembly reuses its materials.
  function batch(root: Group) {
    const batches=new Map<MeshStandardMaterial,BufferGeometry[]>();
    for(const object of [...root.children]) if(object instanceof Mesh) {
      object.updateMatrix();
      const source=object.material as MeshStandardMaterial;
      const material=source.roughness<.2?glossyBatch:source.metalness>=.5?metalBatch:matteBatch;
      const copy=object.geometry.index?object.geometry.toNonIndexed():object.geometry.clone();
      // Normalize the indexed primitives and non-indexed extrusions before merging.
      const colors=new Float32Array(copy.getAttribute('position').count*3);
      for(let i=0;i<colors.length;i+=3) colors.set([source.color.r,source.color.g,source.color.b],i);
      copy.setAttribute('color',new Float32BufferAttribute(colors,3));
      if(!batches.has(material)) batches.set(material,[]);
      batches.get(material)!.push(copy.applyMatrix4(object.matrix));
      object.geometry.dispose(); root.remove(object);
    }
    for(const [material,parts] of batches) {
      const combined=mergeGeometries(parts); parts.forEach(p=>p.dispose());
      if(combined) root.add(new Mesh(combined,material));
    }
  }
  [frame,...rings,...pods].forEach(batch);
  return {frame,rings,pods,dispose() {
    [frame,...rings,...pods].forEach(root=>root.traverse(o=>{if(o instanceof Mesh)o.geometry.dispose();}));
    materials.forEach(m=>m.dispose());
  }};
}
