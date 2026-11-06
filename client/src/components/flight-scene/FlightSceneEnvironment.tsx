import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import { BackSide, BufferGeometry, Color, Float32BufferAttribute, InstancedMesh, Mesh, Object3D } from 'three';
import type { SceneSurfaceTextures } from './sceneSurfaceTextures';

// Cool grey haze follows the photographic panorama's horizon rather than the
// brighter blue of the old procedural sky.
export const SCENE_FOG = { color: '#929ba3', near: 180, far: 1450 };

export function SceneSky({ maps }: { maps: SceneSurfaceTextures }) {
  const dome = useRef<Mesh>(null);
  const uniforms = useMemo(() => ({ map: { value: maps.sky } }), [maps]);
  useFrame(({ camera }) => { dome.current?.position.copy(camera.position); });
  // Render after opaque scenery, at far depth: hidden sky pixels fail the depth
  // test before sampling the panorama. Transparent rotors/trails still follow.
  return <mesh ref={dome} scale={2200} rotation={[0, Math.PI, 0]} renderOrder={1}>
    <sphereGeometry args={[1, 24, 16]} />
    <shaderMaterial uniforms={uniforms} side={BackSide} depthWrite={false} toneMapped={false}
      vertexShader={'varying vec2 skyUv;void main(){skyUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_Position.z=gl_Position.w;}'}
      fragmentShader={'uniform sampler2D map;varying vec2 skyUv;void main(){gl_FragColor=vec4(texture2D(map,skyUv).rgb,1.);}'} />
  </mesh>;
}

const TREE_COUNT = 32;
// Three draws for the entire grove, including its baked ground shade.
function Trees({ maps }: { maps: SceneSurfaceTextures }) {
  const trunks = useRef<InstancedMesh>(null), crowns = useRef<InstancedMesh>(null), shades = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!trunks.current || !crowns.current || !shades.current) return;
    const pose = new Object3D(), color = new Color();
    for (let i = 0; i < TREE_COUNT; i++) {
      const x = i % 2 ? 115 + Math.sin(i * 17.1) * 38 : -105 + Math.sin(i * 17.1) * 35;
      const z = 15 - (i / TREE_COUNT) * 380 + Math.cos(i * 13.3) * 12;
      const size = .8 + (Math.sin(i * 7.7) + 1) * .25;
      pose.position.set(x, size * 1.5, z); pose.rotation.set(0, i * 2.4, 0); pose.scale.set(size * .24, size * 3, size * .24); pose.updateMatrix();
      trunks.current.setMatrixAt(i, pose.matrix);
      for (let lobe = 0; lobe < 3; lobe++) {
        pose.position.set(x + (lobe - 1) * size * .65, size * (lobe === 1 ? 5.2 : 4.1), z + Math.sin(i + lobe) * size * .5);
        pose.scale.set(size * 1.9, size * (lobe === 1 ? 2.4 : 1.8), size * 1.8); pose.updateMatrix();
        crowns.current.setMatrixAt(i * 3 + lobe, pose.matrix);
        color.setHSL(.23 + Math.sin(i * 3.2) * .025, .22, .25 + Math.sin(i * 5.3 + lobe) * .035);
        crowns.current.setColorAt(i * 3 + lobe, color);
      }
      pose.position.set(x + 1.8 * size, .012, z - size); pose.rotation.set(-Math.PI / 2, 0, -.35); pose.scale.set(size * 7, size * 5, 1); pose.updateMatrix();
      shades.current.setMatrixAt(i, pose.matrix);
    }
    for (const mesh of [trunks.current, crowns.current, shades.current]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    crowns.current.instanceColor!.needsUpdate = true;
  }, []);
  return <>
    <instancedMesh ref={trunks} args={[undefined, undefined, TREE_COUNT]}>
      <cylinderGeometry args={[.65, 1, 1, 5]} /><meshLambertMaterial color="#625b48" />
    </instancedMesh>
    <instancedMesh ref={crowns} args={[undefined, undefined, TREE_COUNT * 3]}>
      <icosahedronGeometry args={[1, 0]} /><meshLambertMaterial />
    </instancedMesh>
    <instancedMesh ref={shades} args={[undefined, undefined, TREE_COUNT]}>
      <planeGeometry /><meshBasicMaterial map={maps.shadow} color="#243024" transparent opacity={.32} depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
    </instancedMesh>
  </>;
}

function Hills() {
  const geometry = useMemo(() => {
    const positions: number[] = [], indices: number[] = [], segments = 96;
    for (let ring = 0; ring < 3; ring++) for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2;
      const radius = [650, 1000, 1550][ring];
      const ridge = 70 + Math.sin(angle * 5 + 1) * 32 + Math.sin(angle * 11) * 15 + Math.cos(angle * 3) * 22;
      positions.push(Math.cos(angle) * radius, ring === 1 ? ridge : ring === 2 ? ridge * .6 : -2, Math.sin(angle) * radius);
      if (ring < 2 && i < segments) {
        const a = ring * (segments + 1) + i, b = a + segments + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const result = new BufferGeometry(); result.setAttribute('position', new Float32BufferAttribute(positions, 3)); result.setIndex(indices); result.computeVertexNormals();
    return result;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry}><meshLambertMaterial color="#6f7b63" /></mesh>;
}

function Grass({ maps }: { maps: SceneSurfaceTextures }) {
  const uniforms = useMemo(() => ({
    map: { value: maps.grass }, repeat: { value: maps.grass.repeat },
    haze: { value: new Color(SCENE_FOG.color).convertLinearToSRGB() },
    hazeNear: { value: SCENE_FOG.near }, hazeFar: { value: SCENE_FOG.far },
  }), [maps]);
  // The horizontal field has fixed daylight. Its texture already contains the
  // surface appearance, so one sample plus haze replaces per-pixel lighting and
  // repeated RGB conversions. The aircraft retain their lit materials.
  return <mesh rotation={[-Math.PI / 2, 0, 0]}>
    <planeGeometry args={[4000, 4000]} />
    <shaderMaterial uniforms={uniforms} toneMapped={false} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={4}
      vertexShader={`varying vec2 surfaceUv;varying float depth;uniform vec2 repeat;
        void main(){surfaceUv=uv*repeat;vec4 view=modelViewMatrix*vec4(position,1.);depth=-view.z;gl_Position=projectionMatrix*view;}`}
      fragmentShader={`uniform sampler2D map;uniform vec3 haze;uniform float hazeNear;uniform float hazeFar;
        varying vec2 surfaceUv;varying float depth;
        void main(){vec3 grass=texture2D(map,surfaceUv).rgb;gl_FragColor=vec4(mix(grass,haze,smoothstep(hazeNear,hazeFar,depth)),1.);}`} />
  </mesh>;
}

export const Field = memo(function Field({ grid, groundY, maps }: { grid: boolean; groundY: number; maps: SceneSurfaceTextures }) {
  return <group position={[0, groundY, 0]}>
    <Grass maps={maps} />
    {grid && <Grid position={[0, .03, 0]} args={[500, 500]} cellSize={5} sectionSize={25}
      cellColor="#718372" sectionColor="#a2b4a0" cellThickness={.4} sectionThickness={.65}
      fadeDistance={180} fadeStrength={1.7} />}
    <mesh position={[50, .025, -100]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[18, 320]} /><meshBasicMaterial map={maps.runway} toneMapped={false} /></mesh>
    <mesh position={[-10, .028, 5]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[8, 8]} /><meshBasicMaterial map={maps.pad} toneMapped={false} /></mesh>
    <mesh position={[-35, .018, -32]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[30, 22]} /><meshBasicMaterial map={maps.concrete} toneMapped={false} /></mesh>
    <mesh position={[-32, .01, -51]} rotation={[-Math.PI / 2, 0, 0]} scale={[36, 27, 1]}><planeGeometry /><meshBasicMaterial map={maps.shadow} color="#18221c" transparent opacity={.45} depthWrite={false} /></mesh>
    <mesh position={[-35, 4, -50]}><boxGeometry args={[22, 8, 16]} /><meshStandardMaterial color="#98a5a5" roughness={.85} /></mesh>
    <mesh position={[-35, 3, -41.95]}><boxGeometry args={[13, 6, .1]} /><meshStandardMaterial color="#495756" roughness={.8} /></mesh>
    <Trees maps={maps} /><Hills />
  </group>;
});
