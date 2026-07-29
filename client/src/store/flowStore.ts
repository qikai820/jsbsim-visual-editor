import { create } from 'zustand';
import {
  applyNodeChanges, applyEdgeChanges, addEdge,
  type Node, type Edge, type OnNodesChange, type OnEdgesChange, type Connection,
} from '@xyflow/react';
import { AircraftNodeData, ComponentType, SubFile, SubFileType } from '../types';
import { getComponentDef } from '../utils/componentDefs';

interface FlowState {
  nodes: Node<AircraftNodeData>[];
  edges: Edge[];
  aircraft: { name: string; version: string; release: string };
  selectedNodeId: string | null;
  subFiles: SubFile[];
  editingSubFileId: string | null;

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;
  addNode: (type: ComponentType, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
  updateNodeParams: (id: string, params: Record<string, any>) => void;
  setSelectedNode: (id: string | null) => void;
  setAircraft: (aircraft: { name: string; version: string; release: string }) => void;
  loadProject: (data: { nodes: Node<AircraftNodeData>[]; edges: Edge[]; aircraft: any; subFiles?: SubFile[] }) => void;
  clearAll: () => void;

  addSubFile: (fileType: SubFileType, fileName: string) => void;
  removeSubFile: (id: string) => void;
  updateSubFile: (id: string, data: Partial<SubFile>) => void;
  setEditingSubFile: (id: string | null) => void;
}

let nodeCounter = 0;
let subFileCounter = 0;

export const useFlowStore = create<FlowState>((set, get) => ({
  nodes: [],
  edges: [],
  aircraft: { name: 'New Aircraft', version: '2.0', release: 'PRODUCTION' },
  selectedNodeId: null,
  subFiles: [],
  editingSubFileId: null,

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    set({ edges: addEdge({ ...connection, type: 'smoothstep', animated: true }, get().edges) });
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
    });
  },

  updateNodeParams: (id, params) => {
    set({
      nodes: get().nodes.map(n =>
        n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...params } } } : n
      ),
    });
  },

  setSelectedNode: (id) => set({ selectedNodeId: id }),

  setAircraft: (aircraft) => set({ aircraft }),

  loadProject: (data) => {
    set({
      nodes: data.nodes,
      edges: data.edges,
      aircraft: data.aircraft || { name: 'Loaded Aircraft', version: '2.0', release: 'PRODUCTION' },
      subFiles: data.subFiles || [],
      selectedNodeId: null,
      editingSubFileId: null,
    });
    const maxId = Math.max(0, ...data.nodes.map(n => parseInt(n.id.replace('node-', '')) || 0));
    nodeCounter = maxId;
  },

  clearAll: () => set({ nodes: [], edges: [], selectedNodeId: null, subFiles: [], editingSubFileId: null }),

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
    set({ subFiles: [...get().subFiles, newFile] });
  },

  removeSubFile: (id) => {
    set({
      subFiles: get().subFiles.filter(f => f.id !== id),
      editingSubFileId: get().editingSubFileId === id ? null : get().editingSubFileId,
    });
  },

  updateSubFile: (id, data) => {
    set({
      subFiles: get().subFiles.map(f =>
        f.id === id ? { ...f, ...data, data: { ...f.data, ...(data.data || {}) } } : f
      ),
    });
  },

  setEditingSubFile: (id) => set({ editingSubFileId: id, selectedNodeId: null }),
}));
