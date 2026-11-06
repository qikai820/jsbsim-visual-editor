import { CanvasTexture, NoColorSpace, RepeatWrapping, SRGBColorSpace } from 'three';

// Shared canvas maps start with an immediate procedural fallback, then receive
// bundled CC0 photography once. No remote services or per-frame texture work.
function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

function canvas(width: number, height: number) {
  const image = document.createElement('canvas');
  image.width = width; image.height = height;
  const ctx = image.getContext('2d');
  if (!ctx) throw new Error('Cannot create scene surface texture');
  return { image, ctx };
}

function texture(image: HTMLCanvasElement, repeat = 1) {
  const map = new CanvasTexture(image);
  map.colorSpace = SRGBColorSpace;
  if (repeat !== 1) {
    map.wrapS = map.wrapT = RepeatWrapping;
    map.repeat.set(repeat, repeat);
  }
  return map;
}

function runwayMarkings(a: CanvasRenderingContext2D) {
  const rng = random(4103);
  a.fillStyle = '#ced0c8';
  a.fillRect(9, 16, 3, 2016); a.fillRect(244, 16, 3, 2016);
  for (let y = 130; y < 1950; y += 120) a.fillRect(126, y, 4, 52);
  for (let x = 29; x < 230; x += 27) {
    a.fillRect(x, 34, 13, 67); a.fillRect(x, 1947, 13, 67);
  }
  a.font = 'bold 49px sans-serif'; a.textAlign = 'center'; a.fillText('18', 128, 173);
  a.save(); a.translate(128, 1875); a.rotate(Math.PI); a.fillText('36', 0, 0); a.restore();
  a.fillStyle = 'rgba(19, 23, 23, .09)';
  for (let i = 0; i < 70; i++) {
    const x = 110 + rng() * 36, y = rng() < .5 ? 180 + rng() * 200 : 1640 + rng() * 200;
    a.fillRect(x, y, .5 + rng(), 20 + rng() * 95);
  }
}

function helipadMarkings(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = '#e8ddaa'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(128, 128, 103, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#e8ddaa';
  ctx.fillRect(91, 76, 9, 104); ctx.fillRect(156, 76, 9, 104); ctx.fillRect(91, 124, 74, 9);
}

function noiseLayer(cells: number, rng: () => number) {
  const values = Array.from({ length: cells * cells }, rng);
  return (u: number, v: number) => {
    const x = u * cells, y = v * cells, ix = Math.floor(x), iy = Math.floor(y);
    const sx = x - ix, sy = y - iy, tx = sx * sx * (3 - 2 * sx), ty = sy * sy * (3 - 2 * sy);
    const at = (a: number, b: number) => values[(b % cells) * cells + a % cells];
    const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
    const bottom = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
    return top * (1 - ty) + bottom * ty - .5;
  };
}

export function createSceneSurfaceTextures() {
  const rng = random(4817);
  const grass = canvas(512, 512), pixels = grass.ctx.createImageData(512, 512);
  const broad = noiseLayer(4, rng), patch = noiseLayer(24, rng), fine = noiseLayer(96, rng);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const n = broad(x / 512, y / 512) * 18 + patch(x / 512, y / 512) * 12 + fine(x / 512, y / 512) * 12 + (rng() - .5) * 14;
    const i = (y * 512 + x) * 4;
    pixels.data[i] = 105 + n; pixels.data[i + 1] = 119 + n; pixels.data[i + 2] = 73 + n * .7; pixels.data[i + 3] = 255;
  }
  grass.ctx.putImageData(pixels, 0, 0);

  const asphalt = canvas(256, 2048), road = asphalt.ctx.createImageData(256, 2048);
  for (let y = 0; y < 2048; y++) for (let x = 0; x < 256; x++) {
    const n = (rng() - .5) * 14 + Math.sin(y * .023) * 2;
    const i = (y * 256 + x) * 4;
    road.data[i] = 64 + n; road.data[i + 1] = 68 + n; road.data[i + 2] = 69 + n; road.data[i + 3] = 255;
  }
  asphalt.ctx.putImageData(road, 0, 0);
  runwayMarkings(asphalt.ctx);

  const concrete = canvas(256, 256), c = concrete.ctx;
  c.fillStyle = '#a2a49a'; c.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    c.fillStyle = rng() < .5 ? 'rgba(255,255,235,.06)' : 'rgba(40,45,38,.06)';
    c.fillRect(rng() * 256, rng() * 256, 1, 1);
  }
  c.strokeStyle = 'rgba(55,60,55,.23)'; c.lineWidth = 1;
  for (let p = 0; p < 256; p += 64) { c.beginPath(); c.moveTo(p, 0); c.lineTo(p, 256); c.moveTo(0, p); c.lineTo(256, p); c.stroke(); }
  const pad = canvas(256, 256);
  pad.ctx.drawImage(concrete.image, 0, 0);
  helipadMarkings(pad.ctx);

  const shadow = canvas(64, 64), gradient = shadow.ctx.createRadialGradient(32, 32, 3, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,.65)');
  gradient.addColorStop(.45, 'rgba(255,255,255,.30)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  shadow.ctx.fillStyle = gradient; shadow.ctx.fillRect(0, 0, 64, 64);

  const sky = canvas(1024, 512), skyGradient = sky.ctx.createLinearGradient(0, 0, 0, 256);
  skyGradient.addColorStop(0, '#6194bf'); skyGradient.addColorStop(1, '#929ba3');
  sky.ctx.fillStyle = skyGradient; sky.ctx.fillRect(0, 0, 1024, 512);

  // About 7.4 MiB with mipmaps, including the 1K panorama. The fallback grass
  // uses a 64 m tile; the photograph switches to its measured 2.51 m width.
  const ground = texture(grass.image, 4000 / 64);
  // The baked ground shader samples and outputs display RGB directly.
  ground.colorSpace = NoColorSpace;
  const background = texture(sky.image); background.colorSpace = NoColorSpace;
  const runway = texture(asphalt.image); runway.anisotropy = 2;
  return { grass: ground, runway, concrete: texture(concrete.image), pad: texture(pad.image), shadow: texture(shadow.image), sky: background };
}

export type SceneSurfaceTextures = ReturnType<typeof createSceneSurfaceTextures>;

function tiled(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number, tile: number) {
  const pattern = ctx.createPattern(image, 'repeat');
  if (!pattern) throw new Error('Cannot tile scenery image');
  pattern.setTransform(new DOMMatrix().scale(ctx.canvas.width / width * tile / image.width, ctx.canvas.height / height * tile / image.height));
  ctx.fillStyle = pattern; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** Fill existing maps so materials, uniforms and GPU texture identities persist. */
export function loadSceneSurfaceTextures(maps: SceneSurfaceTextures) {
  let active = true;
  const images: HTMLImageElement[] = [];
  const context = (map: CanvasTexture) => (map.image as HTMLCanvasElement).getContext('2d')!;
  function load(file: string, asset: string, targets: CanvasTexture[], paint: (image: HTMLImageElement) => void) {
    const image = new Image(); images.push(image);
    for (const map of targets) map.userData.polyHaven = { asset, state: 'loading' };
    image.onload = () => {
      if (!active) return;
      try {
        paint(image);
        for (const map of targets) { map.needsUpdate = true; map.userData.polyHaven.state = 'ready'; }
      } catch {
        for (const map of targets) map.userData.polyHaven.state = 'fallback';
      }
    };
    image.onerror = () => { if (active) for (const map of targets) map.userData.polyHaven.state = 'fallback'; };
    image.src = `${import.meta.env.BASE_URL}scenery/polyhaven/${file}`;
  }
  load('sky.jpg', 'kloppenheim_03_puresky', [maps.sky], image => context(maps.sky).drawImage(image, 0, 0, 1024, 512));
  load('grass.jpg', 'grass_ground', [maps.grass], image => {
    context(maps.grass).drawImage(image, 0, 0, 512, 512);
    maps.grass.repeat.set(4000 / 2.51, 4000 / 2.51);
  });
  load('asphalt.jpg', 'asphalt_02', [maps.runway], image => {
    const ctx = context(maps.runway); tiled(ctx, image, 18, 320, 3);
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(0, 0, 256, 2048);
    runwayMarkings(ctx);
  });
  load('concrete.jpg', 'concrete_floor_01', [maps.concrete, maps.pad], image => {
    tiled(context(maps.concrete), image, 30, 22, 2);
    const ctx = context(maps.pad); tiled(ctx, image, 8, 8, 2); helipadMarkings(ctx);
  });
  return () => {
    active = false;
    for (const image of images) { image.onload = null; image.onerror = null; image.src = ''; }
  };
}
