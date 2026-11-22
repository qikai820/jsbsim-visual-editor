import { memo, useEffect, useMemo } from 'react';
import { Grid } from '@react-three/drei';
import { BackSide, BufferGeometry, Color, Float32BufferAttribute } from 'three';
import type { SceneSurfaceTextures } from './sceneSurfaceTextures';

export const SCENE_FOG = { color: '#9eabb6', near: 180, far: 1450 };
const hazeColor = new Color(SCENE_FOG.color).convertLinearToSRGB();

export function SceneSky({ maps }: { maps: SceneSurfaceTextures }) {
  const uniforms = useMemo(() => ({ map: { value: maps.sky }, haze: { value: hazeColor } }), [maps]);
  // Render after opaque scenery, at far depth: hidden sky pixels fail the depth
  // test before sampling the panorama. Transparent rotors/trails still follow.
  // Align the photographed sun with the airfield's directional light.
  return <mesh rotation={[0, Math.PI - .065, 0]} frustumCulled={false} renderOrder={1}>
    <sphereGeometry args={[1, 24, 16]} />
    <shaderMaterial uniforms={uniforms} side={BackSide} depthWrite={false} toneMapped={false}
      vertexShader={`varying vec3 skyDirection;
        varying float longitudeHint;
        void main() {
          skyDirection = position;
          longitudeHint = uv.x;
          // A direction has no translation, so camera motion produces no sky parallax.
          vec3 worldDirection = mat3(modelMatrix) * position;
          gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * worldDirection, 1.);
          gl_Position.z = gl_Position.w;
        }`}
      fragmentShader={`uniform sampler2D map;
        uniform vec3 haze;
        varying vec3 skyDirection;
        varying float longitudeHint;
        void main() {
          vec3 ray = normalize(skyDirection);
          float u = atan(ray.z, -ray.x + 1e-7) * .15915494;
          // Keep neighbouring samples on the same side of the wrap for mip selection.
          u += floor(longitudeHint - u + .5);
          float v = .5 + asin(clamp(ray.y, -1., 1.)) * .31830989;
          vec3 sky = texture2D(map, vec2(u, v)).rgb;
          float luminance = dot(sky, vec3(.2126, .7152, .0722));
          sky += .20 * (sky - luminance) + .22 * sky * (1. - sky);
          gl_FragColor = vec4(mix(haze, sky, smoothstep(-.012, .16, ray.y)), 1.);
        }`} />
  </mesh>;
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
    map: { value: maps.grass }, turfMap: { value: maps.turf }, repeat: { value: maps.grass.repeat },
    haze: { value: hazeColor },
    hazeNear: { value: SCENE_FOG.near }, hazeFar: { value: SCENE_FOG.far },
  }), [maps]);
  // Both sampling scales and the dry patches are anchored in field metres so
  // mowing and ground cover remain stationary while the camera moves.
  return <mesh rotation={[-Math.PI / 2, 0, 0]}>
    <planeGeometry args={[4000, 4000]} />
    <shaderMaterial uniforms={uniforms} toneMapped={false} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={4}
      vertexShader={`varying vec2 field;
        varying vec3 toCamera;
        void main() {
          field = position.xy;
          toCamera = cameraPosition - (modelMatrix * vec4(position, 1.)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
        }`}
      fragmentShader={`uniform sampler2D map, turfMap; uniform vec2 repeat; uniform vec3 haze; uniform float hazeNear, hazeFar;
        varying vec2 field; varying vec3 toCamera;
        float hash(vec2 p) {
          vec3 q = fract(vec3(p.xyx) * .1031);
          q += dot(q, q.yzx + 33.33);
          return fract((q.x + q.y) * q.z);
        }
        float growthNoise(vec2 p) {
          vec2 i = floor(p), t = fract(p);
          t = t * t * (3. - 2. * t);
          return mix(mix(hash(i), hash(i + vec2(1,0)), t.x),
                     mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), t.x), t.y);
        }
        void main() {
          float distanceToCamera = length(toCamera);
          vec2 rotatedField = mat2(.8, -.6, .6, .8) * field;
          float broadGrowth = growthNoise(field * .022 + vec2(8.7, -4.1));
          float localGrowth = growthNoise(rotatedField * .14);
          float cover = mix(.24, .95, smoothstep(.22, .78, mix(broadGrowth, localGrowth, .42)));
          vec3 dryGrass = texture2D(map, field * (repeat / 4000.)).rgb * vec3(1.10, 1.12, 1.10);
          vec2 turfUv = rotatedField / 1.4 + vec2(.17, .39);
          vec3 greenGrass = texture2D(turfMap, turfUv).rgb * vec3(1.06, 1.06, 1.14);
          vec3 grass = mix(dryGrass, greenGrass, cover);
          // Uneven growth breaks up the contrast of the mowing passes.
          float mowing = .014 * sin(field.x * .74 + .18 * sin(field.y * .033));
          grass *= .88 + .24 * broadGrowth + .13 * localGrowth
            + mowing * cover * (1. - smoothstep(60., 220., distanceToCamera));
          gl_FragColor = vec4(mix(grass, haze, smoothstep(hazeNear, hazeFar, distanceToCamera)), 1.);
        }`} />
  </mesh>;
}

export const Field = memo(function Field({ grid, groundY, maps, scenery = true }: { grid: boolean; groundY: number; maps: SceneSurfaceTextures; scenery?: boolean }) {
  return <group position={[0, groundY, 0]}>
    {scenery && <Grass maps={maps} />}
    {grid && <Grid position={[0, .03, 0]} args={[500, 500]} cellSize={5} sectionSize={25}
      cellColor="#718372" sectionColor="#a2b4a0" cellThickness={.4} sectionThickness={.65}
      fadeDistance={180} fadeStrength={1.7} />}
    {scenery && <>
      <mesh position={[-10, .028, 5]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[8, 8]} /><meshBasicMaterial map={maps.pad} toneMapped={false} /></mesh>
      <Hills />
    </>}
  </group>;
});
