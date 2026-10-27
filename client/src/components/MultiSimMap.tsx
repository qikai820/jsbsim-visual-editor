import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import type { SimInstanceSummary } from '../utils/tauriApi';
import { fleetSlotIds, type FleetInitialOverrides } from '../utils/fleetModelGroups';

// v1 may contain a center shifted 180° by the old inverse projection.
const VIEW_STORAGE = 'jsbsim-multi-map-view-v2';
const REFIT_TARGET_STORAGE = 'jsbsim-multi-map-refit-target-v1';
const DEFAULT_VIEW = { lat: 34.2813748, lng: 109.0324104, zoom: 12 };
const TILE_SIZE = 256;
const MAX_LATITUDE = 85.05112878;
const MIN_ZOOM = 2;
const MAX_ZOOM = 19;

type MapView = typeof DEFAULT_VIEW;
type Point = { x: number; y: number };
type AircraftPosition = { id: string; lat: number; lng: number; model: string; altitude?: number;
  source: 'live' | 'initial' | 'last' };

function savedView(): MapView | null {
  try {
    const view = JSON.parse(localStorage.getItem(VIEW_STORAGE) || 'null');
    if (Number.isFinite(view?.lat) && Math.abs(view.lat) <= MAX_LATITUDE &&
        Number.isFinite(view?.lng) && Math.abs(view.lng) <= 180 &&
        Number.isInteger(view?.zoom) && view.zoom >= MIN_ZOOM && view.zoom <= MAX_ZOOM) return view;
  } catch { /* Ignore an invalid saved view. */ }
  return null;
}

function pendingRefitTarget(): { lat: number; lng: number } | null {
  try {
    const target = JSON.parse(localStorage.getItem(REFIT_TARGET_STORAGE) || 'null');
    if (Number.isFinite(target?.lat) && Math.abs(target.lat) <= 90 &&
        Number.isFinite(target?.lng) && Math.abs(target.lng) <= 180) return target;
  } catch { /* Ignore an invalid correction target. */ }
  return null;
}

function project(lat: number, lng: number, zoom: number): Point {
  const scale = TILE_SIZE * 2 ** zoom;
  const limitedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const sinLat = Math.sin(limitedLat * Math.PI / 180);
  return { x: (lng + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale };
}

function unproject(point: Point, zoom: number): { lat: number; lng: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * point.y / scale))) * 180 / Math.PI;
  return { lat: Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude)),
    lng: ((point.x / scale * 360) % 360 + 360) % 360 - 180 };
}

// Match QGC's Bing Satellite quadkey, server choice and tile version.
function bingTileUrl(x: number, y: number, zoom: number): string {
  const tileX = ((x % 2 ** zoom) + 2 ** zoom) % 2 ** zoom;
  let quadkey = '';
  for (let bit = zoom; bit > 0; bit--) {
    const mask = 1 << (bit - 1);
    quadkey += String(Number((tileX & mask) !== 0) + 2 * Number((y & mask) !== 0));
  }
  const server = (tileX + 2 * y) % 4;
  return `https://ecn.t${server}.tiles.virtualearth.net/tiles/a${quadkey}.jpg?g=2981&mkt=zh-CN`;
}

function aircraftPosition(item: SimInstanceSummary, connected: boolean): AircraftPosition | null {
  const lat = item.latitude_deg;
  const lng = item.longitude_deg;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || Math.abs(lng) > 180) return null;
  return { id: item.instance_id, lat, lng, model: item.model || '未命名模型',
    altitude: item.altitude_m,
    source: connected && (item.age_ms ?? Infinity) < 2000 &&
      (item.state === 'running' || item.state === 'paused') ? 'live' : 'last' };
}

function distanceMeters(a: AircraftPosition, b: AircraftPosition): number {
  const north = (a.lat - b.lat) * 111_320;
  const east = (a.lng - b.lng) * 111_320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(north, east);
}

interface Props {
  connected: boolean;
  instances: SimInstanceSummary[];
  selected: string;
  slots: Record<string, string>;
  initialOverrides: FleetInitialOverrides;
  onSelect: (id: string) => void;
}

export default function MultiSimMap({ connected, instances, selected, slots, initialOverrides, onSelect }: Props) {
  const restoredView = useRef(savedView());
  const refitTarget = useRef(pendingRefitTarget());
  const [view, setView] = useState<MapView>(() => restoredView.current ?? DEFAULT_VIEW);
  const autoFitPending = useRef(restoredView.current === null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const mapNode = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; center: Point; zoom: number } | null>(null);
  const positions = useMemo(() => {
    const byId = new Map(instances.map(item => [item.instance_id, item]));
    return fleetSlotIds(slots).flatMap(id => {
      const item = byId.get(id);
      const reported = item ? aircraftPosition(item, connected) : null;
      if (reported) return [reported];
      const initial = initialOverrides[id];
      if (initial && slots[id]) return [{ id, lat: initial.latitudeDeg, lng: initial.longitudeDeg,
        model: slots[id], altitude: initial.altitudeM, source: 'initial' as const }];
      return [];
    });
  }, [instances, connected, slots, initialOverrides]);
  const reportedPositions = positions.filter(point => point.source !== 'initial');
  const fitPositions = reportedPositions.length ? reportedPositions : positions;
  const selectedPosition = positions.find(point => point.id === selected);
  const selectedStart = initialOverrides[selected];
  const distanceFromStart = selectedPosition && selectedStart ? distanceMeters(selectedPosition, {
    id: selected, lat: selectedStart.latitudeDeg, lng: selectedStart.longitudeDeg,
    model: slots[selected], source: 'initial',
  }) : null;
  const nearby = positions.length > 1 &&
    Math.max(...positions.map(point => distanceMeters(positions[0], point))) < 10;
  const center = project(view.lat, view.lng, view.zoom);
  const worldWidth = TILE_SIZE * 2 ** view.zoom;

  useEffect(() => {
    if (!mapNode.current) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(mapNode.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!autoFitPending.current) localStorage.setItem(VIEW_STORAGE, JSON.stringify(view));
  }, [view]);

  const tiles = useMemo(() => {
    if (!size.width || !size.height) return [];
    const result: { key: string; url: string; left: number; top: number }[] = [];
    const firstX = Math.floor((center.x - size.width / 2) / TILE_SIZE);
    const lastX = Math.floor((center.x + size.width / 2) / TILE_SIZE);
    const firstY = Math.max(0, Math.floor((center.y - size.height / 2) / TILE_SIZE));
    const lastY = Math.min(2 ** view.zoom - 1, Math.floor((center.y + size.height / 2) / TILE_SIZE));
    for (let y = firstY; y <= lastY; y++) for (let x = firstX; x <= lastX; x++) {
      result.push({ key: `${view.zoom}/${x}/${y}`, url: bingTileUrl(x, y, view.zoom),
        left: x * TILE_SIZE - center.x + size.width / 2,
        top: y * TILE_SIZE - center.y + size.height / 2 });
    }
    return result;
  }, [center.x, center.y, size.width, size.height, view.zoom]);

  const markers = useMemo(() => positions.map(point => {
    const projected = project(point.lat, point.lng, view.zoom);
    let dx = projected.x - center.x;
    if (dx > worldWidth / 2) dx -= worldWidth;
    if (dx < -worldWidth / 2) dx += worldWidth;
    return { point, x: size.width / 2 + dx,
      y: size.height / 2 + projected.y - center.y };
  }), [positions, center.x, center.y, size.width, size.height, view.zoom, worldWidth]);

  function updateView(next: MapView | ((current: MapView) => MapView)) {
    autoFitPending.current = false;
    setView(next);
  }

  function fitAll() {
    if (!fitPositions.length) return;
    const width = Math.max(size.width - 120, 250);
    const height = Math.max(size.height - 120, 200);
    let zoom = 2;
    if (Math.max(...fitPositions.map(point => distanceMeters(fitPositions[0], point))) < 50) zoom = 17;
    else for (let candidate = MAX_ZOOM; candidate >= MIN_ZOOM; candidate--) {
      const points = fitPositions.map(point => project(point.lat, point.lng, candidate));
      const spanX = Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x));
      const spanY = Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y));
      if (spanX <= width && spanY <= height) { zoom = candidate; break; }
    }
    const points = fitPositions.map(point => project(point.lat, point.lng, zoom));
    updateView({ ...unproject({ x: (Math.min(...points.map(point => point.x)) + Math.max(...points.map(point => point.x))) / 2,
      y: (Math.min(...points.map(point => point.y)) + Math.max(...points.map(point => point.y))) / 2 }, zoom), zoom });
  }

  useEffect(() => {
    const target = refitTarget.current;
    if (target && size.width && size.height && positions.some(point =>
      Math.abs(point.lat - target.lat) < 0.0001 && Math.abs(point.lng - target.lng) < 0.0001)) {
      refitTarget.current = null;
      localStorage.removeItem(REFIT_TARGET_STORAGE);
      fitAll();
      return;
    }
    if (autoFitPending.current && size.width && size.height && positions.length) fitAll();
  }, [positions, size.width, size.height]);

  function panPixels(dx: number, dy: number) {
    updateView(current => ({ ...unproject({ x: project(current.lat, current.lng, current.zoom).x + dx,
      y: project(current.lat, current.lng, current.zoom).y + dy }, current.zoom), zoom: current.zoom }));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, center, zoom: view.zoom };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const start = drag.current;
    updateView({ ...unproject({ x: start.center.x - (event.clientX - start.x),
      y: start.center.y - (event.clientY - start.y) }, start.zoom), zoom: start.zoom });
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function onWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    updateView(current => ({ ...current,
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom + (event.deltaY < 0 ? 1 : -1))) }));
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100],
    };
    if (moves[event.key]) { event.preventDefault(); panPixels(...moves[event.key]); }
    else if (event.key === '+' || event.key === '=') updateView(current => ({ ...current, zoom: Math.min(MAX_ZOOM, current.zoom + 1) }));
    else if (event.key === '-') updateView(current => ({ ...current, zoom: Math.max(MIN_ZOOM, current.zoom - 1) }));
  }

  return <section className="multi-sim-map" aria-label="机群地图">
    <div className="multi-sim-map-canvas" ref={mapNode} role="application" tabIndex={0}
      aria-label="Bing 卫星地图，方向键平移，加减号缩放，显示各架飞机位置"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp} onWheel={onWheel} onKeyDown={onKeyDown}>
      <div className="multi-sim-map-actions">
        <button type="button" disabled={!positions.length} onPointerDown={event => event.stopPropagation()} onClick={fitAll}>显示全部</button>
        <button type="button" disabled={!selectedPosition} onPointerDown={event => event.stopPropagation()} onClick={() => {
          if (selectedPosition) updateView({ lat: selectedPosition.lat, lng: selectedPosition.lng, zoom: 17 });
        }}>定位选中</button>
      </div>
      {tiles.map(tile => <img key={tile.key} src={tile.url} alt="" draggable={false}
        className="multi-sim-map-tile" style={{ left: tile.left, top: tile.top }} />)}
      {markers.map(({ point, x, y }) => <span key={point.id}
        className={`multi-sim-map-marker${point.id === selected ? ' selected' : ''}${point.source === 'live' ? '' : ` ${point.source}`}`}
        style={{ left: x, top: y }} onPointerDown={event => event.stopPropagation()} onClick={() => onSelect(point.id)}
        title={`${point.id} · ${point.model} · ${point.source === 'live' ? '实时遥测' : point.source === 'initial' ? '编组起点，尚无飞机位置遥测' : '最后位置'} · ${point.lat}, ${point.lng}${Number.isFinite(point.altitude) ? ` · ${point.altitude?.toFixed(1)} m` : ''}`}>{point.source === 'initial' ? `起${point.id}` : point.id}</span>)}
      {!positions.length && <div className="multi-sim-map-message">等待飞机经纬度遥测或仿真组初始位置</div>}
      {selectedPosition && <div className="multi-sim-map-coordinate">
        <strong>实例 {selected} · {selectedPosition.source === 'live' ? '实时遥测' : selectedPosition.source === 'initial' ? '编组起点（尚无飞机位置）' : '最后位置'}</strong>
        <span>{Math.abs(selectedPosition.lat)}° {selectedPosition.lat < 0 ? 'S' : 'N'}，{Math.abs(selectedPosition.lng)}° {selectedPosition.lng < 0 ? 'W' : 'E'}</span>
        {Number.isFinite(selectedPosition.altitude) && <span>{selectedPosition.source === 'initial' ? '地面海拔' : '飞机海拔'} {selectedPosition.altitude?.toFixed(1)} m</span>}
        {selectedPosition.source !== 'initial' && selectedStart && <small>编组起点 {selectedStart.latitudeDeg}°，{selectedStart.longitudeDeg}° · 水平偏移 {distanceFromStart?.toFixed(2)} m</small>}
        {nearby && <small>飞机间距很近，地图点位按真实比例重叠；可在实例列表中切换查看坐标。</small>}
      </div>}
      <div className="multi-sim-map-zoom" aria-label="地图缩放">
        <button type="button" disabled={view.zoom >= MAX_ZOOM} onPointerDown={event => event.stopPropagation()}
          onClick={() => updateView(current => ({ ...current, zoom: Math.min(MAX_ZOOM, current.zoom + 1) }))}>+</button>
        <button type="button" disabled={view.zoom <= MIN_ZOOM} onPointerDown={event => event.stopPropagation()}
          onClick={() => updateView(current => ({ ...current, zoom: Math.max(MIN_ZOOM, current.zoom - 1) }))}>−</button>
      </div>
      <div className="multi-sim-map-attribution">Bing Maps · © Microsoft</div>
    </div>
  </section>;
}
