import { create } from 'zustand';
import {
  applyNodeChanges, applyEdgeChanges, addEdge,
  type Node, type Edge, type OnNodesChange, type OnEdgesChange, type Connection,
} from '@xyflow/react';
import { AircraftNodeData, ComponentType, ProjectXmlFile, SubFile, SubFileType } from '../types';
import { getComponentDef } from '../utils/componentDefs';

interface FlowState {
  nodes: Node<AircraftNodeData>[];
  edges: Edge[];
  aircraft: { name: string; version: string; release: string; type?: 'fixed_wing' | 'helicopter' | 'multirotor' };
  selectedNodeId: string | null;
  subFiles: SubFile[];
  xmlFiles: ProjectXmlFile[];
  editingSubFileId: string | null;
  focusedNodeId: string | null;

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;
  updateEdgeData: (id: string, patch: Record<string, any>) => void;
  addNode: (type: ComponentType, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
  updateNodeParams: (id: string, params: Record<string, any>) => void;
  setSelectedNode: (id: string | null) => void;
  setFocusedNodeId: (id: string | null) => void;
  setAircraft: (aircraft: { name: string; version: string; release: string }) => void;
  loadProject: (data: { nodes: Node<AircraftNodeData>[]; edges: Edge[]; aircraft: any; subFiles?: SubFile[]; xmlFiles?: ProjectXmlFile[] }) => void;
  clearAll: () => void;
  restoreLayout: () => void;

  addSubFile: (fileType: SubFileType, fileName: string) => void;
  removeSubFile: (id: string) => void;
  updateSubFile: (id: string, data: Partial<SubFile>) => void;
  setEditingSubFile: (id: string | null) => void;
}

let nodeCounter = 0;
let subFileCounter = 0;

export function resolveNodeOwnedPath(node: Node<AircraftNodeData> | undefined): string {
  if (!node) return '';
  const type = node.data.componentType;
  if (!['system', 'flight_control', 'engine', 'propeller'].includes(type)) return '';
  const params = node.data.params || {};
  let raw = String(params.referencePath || params._source_file || params.file || '').trim();
  // v2 cached projects expanded referenced files but discarded their `file`
  // attribute. Recover the well-known F450 module ownership from the module
  // identity so editing an old cached sensor cannot fall back to F450.xml.
  if (!raw && (type === 'system' || type === 'flight_control')) {
    const identity = `${node.data.label || ''} ${params.name || ''}`.toLowerCase();
    if (identity.includes('sensor') && identity.includes('imu')) raw = 'SensorImu.xml';
    else if (identity.includes('sensor') && (identity.includes('baro') || identity.includes('barometer'))) raw = 'SensorBaro.xml';
    else if (identity.includes('sensor') && identity.includes('gps')) raw = 'SensorGps.xml';
    else if (identity.includes('effectors')) raw = 'Effectors.xml';
    else if (type === 'flight_control' && (identity.includes('fcs') || identity.includes('flight'))) raw = 'FlightControl.xml';
  }
  if (!raw) return '';
  const withExt = raw.toLowerCase().endsWith('.xml') ? raw : `${raw}.xml`;
  return withExt.includes('/') ? withExt
    : type === 'system' || type === 'flight_control' ? `systems/${withExt}` : `engine/${withExt}`;
}

function normalizeNodeOwnership(node: Node<AircraftNodeData>): Node<AircraftNodeData> {
  const type = node.data.componentType;
  const path = resolveNodeOwnedPath(node);
  if (!path) return node;
  const params = node.data.params || {};
  const category = type === 'system' || type === 'flight_control' ? 'system' : 'engine';
  const fileName = path.split('/').pop()?.replace(/\.xml$/i, '') || '';
  return {
    ...node,
    data: {
      ...node.data,
      params: {
        ...params,
        file: params.file || fileName,
        _source_file: params._source_file || fileName,
        referencePath: path,
        source: { fileId: `${category}:${path}`, path, category },
      },
    },
  };
}

// Convert aircraft's physical coordinates into a compact display layout while
// retaining their relative arrangement.  A minimum grid spacing prevents the
// scaled coordinates from making cards overlap.
function compactDisplayNodes(nodes: Node<AircraftNodeData>[]): Node<AircraftNodeData>[] {
  if (nodes.length < 2) return nodes;
  const toInches = (value: unknown, unit: string) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    switch (unit.toUpperCase()) {
      case 'M': case 'MTR': return number * 39.3701;
      case 'CM': return number * 0.393701;
      case 'FT': return number * 12;
      default: return number;
    }
  };
  const located: { node: Node<AircraftNodeData>; physicalX: number; physicalY: number }[] = [];
  const unlocated: Node<AircraftNodeData>[] = [];
  for (const node of nodes) {
    const location = node.data.params?.location || node.data.params?.cg;
    const unit = String(location?.unit || 'IN');
    const physicalX = toInches(location?.x, unit);
    const physicalY = toInches(location?.y, unit);
    if (physicalX !== null && physicalY !== null) located.push({ node, physicalX, physicalY });
    else unlocated.push(node);
  }
  if (located.length === 0) return nodes;

  const physicalXs = located.map(item => item.physicalX);
  const physicalYs = located.map(item => item.physicalY);
  const minPhysicalX = Math.min(...physicalXs), maxPhysicalX = Math.max(...physicalXs);
  const minPhysicalY = Math.min(...physicalYs), maxPhysicalY = Math.max(...physicalYs);
  const spanForward = Math.max(1, maxPhysicalX - minPhysicalX);
  const spanLateral = Math.max(1, maxPhysicalY - minPhysicalY);
  // One scale is applied to both axes: large aircraft shrink, small aircraft
  // grow only enough to remain legible, and X/Y proportions stay truthful.
  const scale = Math.min(820 / spanLateral, 560 / spanForward);
  const sorted = located.map(item => ({
    node: item.node,
    x: 80 + (item.physicalY - minPhysicalY) * scale,
    // A propeller/thruster is mounted at the same physical point as its
    // engine.  Draw its card just ahead of the engine so the shared x/y
    // remains apparent without stacking both cards on top of each other.
    y: 60 + (maxPhysicalX - item.physicalX) * scale
      - (item.node.data.componentType === 'propeller' ? 145 : 0),
  })).sort((a, b) => a.y - b.y || a.x - b.x);
  // Keep the uniformly scaled X/Y placement.  Only cards whose rectangles
  // actually overlap are nudged to the nearest free point around their
  // physical location; this avoids converting the aircraft into a row/grid.
  const placed: typeof sorted = [];
  const overlaps = (x: number, y: number) => placed.some(item =>
    Math.abs(x - item.x) < 188 && Math.abs(y - item.y) < 100);
  for (const current of sorted) {
    const baseX = current.x, baseY = current.y;
    if (overlaps(baseX, baseY)) {
      for (let step = 1; step <= 48; step++) {
        const ring = Math.ceil(step / 8);
        const angle = (step % 8) * Math.PI / 4;
        const candidateX = Math.max(20, baseX + Math.cos(angle) * ring * 58);
        const candidateY = Math.max(20, baseY + Math.sin(angle) * ring * 45);
        if (!overlaps(candidateX, candidateY)) {
          current.x = candidateX;
          current.y = candidateY;
          break;
        }
      }
    }
    placed.push(current);
  }
  const positions = new Map(sorted.map(item => [item.node.id, { x: item.x, y: item.y }]));
  const aircraftRight = Math.max(...sorted.map(item => item.x)) + 220;
  unlocated.forEach((node, index) => {
    positions.set(node.id, {
      x: aircraftRight + (index % 2) * 205,
      y: 60 + Math.floor(index / 2) * 108,
    });
  });
  return nodes.map(n => ({
    ...n,
    position: positions.get(n.id)!,
  }));
}

export const useFlowStore = create<FlowState>((set, get) => ({
  nodes: [],
  edges: [],
  aircraft: { name: 'New Aircraft', version: '2.0', release: 'PRODUCTION' },
  selectedNodeId: null,
  subFiles: [],
  xmlFiles: [],
  editingSubFileId: null,
  focusedNodeId: null,

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) as Node<AircraftNodeData>[] });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    const state = get();
    const source = state.nodes.find(n => n.id === connection.source);
    const target = state.nodes.find(n => n.id === connection.target);
    const nextEdges = addEdge({ ...connection, type: 'smoothstep', animated: true }, state.edges);

    // A sensor-to-UAVCAN connection selects a standard DSDL type and copies
    // the corresponding JSBSim property mapping into the protocol node.
    if (source && target?.data.componentType === 'uavcan') {
      const sourceName = `${source.data.label || ''} ${source.data.params?.file || ''}`.toLowerCase();
      const sensorType = sourceName.includes('gps') ? 'GPS' : sourceName.includes('baro') ? 'BAROMETER' : sourceName.includes('mag') ? 'MAG' : sourceName.includes('airspeed') ? 'AIRSPEED' : 'IMU';
      const presets: Record<string, { dsdl_type: string; properties: string }> = {
        IMU: { dsdl_type: 'uavcan.si.sample.acceleration.Vector3.1.0', properties: 'sensor/imu/accelX_mps2,sensor/imu/accelY_mps2,sensor/imu/accelZ_mps2' },
        MAG: { dsdl_type: 'uavcan.si.sample.magnetic_flux_density.Vector3.1.0', properties: 'sensor/imu/magX_nT,sensor/imu/magY_nT,sensor/imu/magZ_nT' },
        BAROMETER: { dsdl_type: 'uavcan.si.sample.pressure.Scalar.1.0', properties: 'sensor/baro/pressure_hpa' },
        GPS: { dsdl_type: 'reg.udral.physics.kinematics.geodetic.PointStateVarTs.0.1', properties: 'sensor/gps/lat_rad,sensor/gps/long_rad,sensor/gps/alt_m,sensor/gps/vNorth_mps,sensor/gps/vEast_mps,sensor/gps/vDown_mps' },
        AIRSPEED: { dsdl_type: 'uavcan.si.sample.velocity.Scalar.1.0', properties: 'velocities/vc-kts' },
      };
      set({ edges: nextEdges, nodes: state.nodes.map(n => n.id === target.id ? { ...n, data: { ...n.data, params: { ...n.data.params, sensor_type: sensorType, ...presets[sensorType] } } } : n) });
      return;
    }

    // A sensor-to-HIL connection is also a configuration action.  Copy the
    // standard sensor-module property paths into the selected protocol.
    if (source && target?.data.componentType === 'output') {
      const sourceName = `${source.data.label || ''} ${source.data.params?.file || ''}`.toLowerCase();
      const targetType = target.data.params?.type;
      const patch: Record<string, string> = {};
      if (targetType === 'HIL_SENSOR' && sourceName.includes('imu')) {
        Object.assign(patch, {
          hil_imu_accel_x: 'sensor/imu/accelX_mps2',
          hil_imu_accel_y: 'sensor/imu/accelY_mps2',
          hil_imu_accel_z: 'sensor/imu/accelZ_mps2',
          hil_imu_gyro_x: 'sensor/imu/gyroX_rps',
          hil_imu_gyro_y: 'sensor/imu/gyroY_rps',
          hil_imu_gyro_z: 'sensor/imu/gyroZ_rps',
        });
      } else if (targetType === 'HIL_GPS' && sourceName.includes('gps')) {
        Object.assign(patch, {
          hil_gps_lat: 'sensor/gps/lat_rad',
          hil_gps_lon: 'sensor/gps/long_rad',
          hil_gps_alt: 'sensor/gps/alt_m',
          hil_gps_vn: 'sensor/gps/vNorth_mps',
          hil_gps_ve: 'sensor/gps/vEast_mps',
          hil_gps_vd: 'sensor/gps/vDown_mps',
        });
      }
      if (Object.keys(patch).length > 0) {
        set({ edges: nextEdges, nodes: state.nodes.map(n => n.id === target.id
          ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } }
          : n) });
        return;
      }
    }
    set({ edges: nextEdges });
  },

  updateEdgeData: (id, patch) => {
    set({ edges: get().edges.map(e => (e.id === id ? { ...e, data: { ...e.data, ...patch } } : e)) });
  },

  addNode: (type, position) => {
    const def = getComponentDef(type);
    if (!def) return;
    const id = `node-${++nodeCounter}`;
    const params: Record<string, any> = {};
    for (const [key, paramDef] of Object.entries(def.params)) {
      params[key] = paramDef.default;
    }
    const newNode: Node<AircraftNodeData> = {
      id,
      type: 'aircraftComponent',
      position,
      data: {
        label: def.label,
        componentType: type,
        params,
      },
    };
    set({ nodes: [...get().nodes, newNode] });
  },

  removeNode: (id) => {
    set({
      nodes: get().nodes.filter(n => n.id !== id),
      edges: get().edges.filter(e => e.source !== id && e.target !== id),
      selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
      focusedNodeId: get().focusedNodeId === id ? null : get().focusedNodeId,
    });
  },

  updateNodeParams: (id, params) => {
    const state = get();
    const node = state.nodes.find(n => n.id === id);
    const nextNodes = state.nodes.map(n =>
      n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...params } } } : n
    );
    const sourcePath = resolveNodeOwnedPath(node) || String(node?.data.params?.source?.path || '').trim();
    const xmlFiles = sourcePath
      ? state.xmlFiles.map(file => file.path === sourcePath ? { ...file, dirty: true } : file)
      : state.xmlFiles;
    set({ nodes: nextNodes, xmlFiles });
  },

  restoreLayout: () => {
    set({ nodes: compactDisplayNodes(get().nodes) });
  },

  setSelectedNode: (id) => set({ selectedNodeId: id }),

  setFocusedNodeId: (id) => set({ focusedNodeId: id }),

  setAircraft: (aircraft) => set({ aircraft }),

  loadProject: (data) => {
    const ownedNodes = data.nodes.map(normalizeNodeOwnership);
    set({
      nodes: (data as any).preserveLayout ? ownedNodes : compactDisplayNodes(ownedNodes),
      edges: data.edges,
      aircraft: data.aircraft || { name: 'Loaded Aircraft', version: '2.0', release: 'PRODUCTION' },
      subFiles: data.subFiles || [],
      xmlFiles: (data as any).xmlFiles || [],
      selectedNodeId: null,
      editingSubFileId: null,
      focusedNodeId: null,
    });
    const maxId = Math.max(0, ...data.nodes.map(n => parseInt(n.id.replace('node-', '')) || 0));
    nodeCounter = maxId;
  },

  clearAll: () => set({ nodes: [], edges: [], selectedNodeId: null, subFiles: [], xmlFiles: [], editingSubFileId: null, focusedNodeId: null }),

  addSubFile: (fileType, fileName) => {
    const id = `sf-${++subFileCounter}`;
    const defaultData: any = { name: fileName };
    if (fileType === 'engine') {
      defaultData.engineType = 'piston';
      defaultData.maxHP = 200;
      defaultData.displacement = 360;
      defaultData.maxRPM = 2700;
      defaultData.idleRPM = 600;
    } else if (fileType === 'thruster') {
      defaultData.thrusterType = 'propeller';
      defaultData.diameter = 6.25;
      defaultData.numBlades = 2;
    } else {
      defaultData.properties = [];
    }
    const newFile: SubFile = { id, fileName, fileType, data: defaultData };
    const category = fileType === 'system' ? 'system' : fileType === 'thruster' ? 'thruster' : 'engine';
    const path = `${category === 'system' ? 'systems' : 'engine'}/${fileName.replace(/\.xml$/i, '')}.xml`;
    const xmlFile: ProjectXmlFile = { id: `${category}:${path}`, path, category, originalXml: '', currentXml: '', dirty: true };
    set({ subFiles: [...get().subFiles, newFile], xmlFiles: [...get().xmlFiles, xmlFile] });
  },

  removeSubFile: (id) => {
    set({
      subFiles: get().subFiles.filter(f => f.id !== id),
      editingSubFileId: get().editingSubFileId === id ? null : get().editingSubFileId,
    });
  },

  updateSubFile: (id, data) => {
    const state = get();
    const subFiles = state.subFiles.map(f =>
      f.id === id ? { ...f, ...data, data: { ...f.data, ...(data.data || {}) } } : f
    );
    const changed = subFiles.find(f => f.id === id);
    const xmlFiles = changed ? state.xmlFiles.map(file => {
      const path = file.path.split('/').pop()?.replace(/\.xml$/i, '');
      return path === changed.fileName.replace(/\.xml$/i, '')
        ? { ...file, dirty: true }
        : file;
    }) : state.xmlFiles;
    set({ subFiles, xmlFiles });
  },

  setEditingSubFile: (id) => set({ editingSubFileId: id, selectedNodeId: null }),
}));
