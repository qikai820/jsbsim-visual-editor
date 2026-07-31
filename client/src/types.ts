import type { Node, Edge } from '@xyflow/react';

export type ComponentType =
  | 'fuselage' | 'wing' | 'htail' | 'vtail'
  | 'engine' | 'propeller'
  | 'landing_gear' | 'fuel_tank' | 'point_mass'
  | 'inertia' | 'aero_coefficients' | 'system' | 'flight_control' | 'output';

export type SubFileType = 'engine' | 'thruster' | 'system';

export interface ParamDef {
  label: string;
  type: 'number' | 'string' | 'select' | 'location' | 'vector3';
  default: any;
  unit?: string;
  options?: string[];
}

export interface ComponentDef {
  type: ComponentType;
  label: string;
  category: string;
  color: string;
  icon: string;
  description: string;
  params: Record<string, ParamDef>;
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
}

export interface EngineDef {
  name: string;
  engineType: 'piston' | 'turbine' | 'rocket' | 'electric';
  maxHP?: number;
  maxThrust?: number;
  displacement?: number;
  cycles?: number;
  bsfc?: number;
  starterTorque?: number;
  idleRPM?: number;
  maxRPM?: number;
  minMP?: number;
  maxMP?: number;
  [key: string]: any;
}

export interface ThrusterDef {
  name: string;
  thrusterType: 'propeller' | 'direct' | 'nozzle';
  diameter?: number;
  numBlades?: number;
  gearRatio?: number;
  [key: string]: any;
}

export interface SystemDef {
  name: string;
  properties: { name: string; value?: number }[];
}

export interface SubFile {
  id: string;
  fileName: string;
  fileType: SubFileType;
  data: EngineDef | ThrusterDef | SystemDef;
}

export interface AircraftNodeData {
  label: string;
  componentType: ComponentType;
  params: Record<string, any>;
  [key: string]: any;
}

export type AircraftNode = Node<AircraftNodeData>;
export type AircraftEdge = Edge;

// ── Expression Tree Types (Simulink-style function blocks) ──────────────────

export type ExprNode =
  | ExprValue
  | ExprProperty
  | ExprFunctionRef
  | ExprTable
  | ExprProduct
  | ExprSum
  | ExprDifference
  | ExprQuotient
  | ExprPow
  | ExprUnary
  | ExprAtan2
  | ExprIfThen
  | ExprSwitch
  | ExprComparison;

export interface ExprValue {
  kind: 'value';
  value: number;
}

export interface ExprProperty {
  kind: 'property';
  name: string;
}

export interface ExprFunctionRef {
  kind: 'function_ref';
  name: string;
}

export interface ExprTable {
  kind: 'table';
  tableType: '1D' | '2D' | '3D';
  var1: string;
  var2: string;
  var3: string;
  data: number[][];
  breakpoints1: number[];
  breakpoints2: number[];
  breakpoints3: number[];
}

export interface ExprProduct {
  kind: 'product';
  children: ExprNode[];
}

export interface ExprSum {
  kind: 'sum';
  children: ExprNode[];
}

export interface ExprDifference {
  kind: 'difference';
  left: ExprNode;
  right: ExprNode;
}

export interface ExprQuotient {
  kind: 'quotient';
  left: ExprNode;
  right: ExprNode;
}

export interface ExprPow {
  kind: 'pow';
  base: ExprNode;
  exponent: ExprNode;
}

export type UnaryOp = 'abs' | 'sin' | 'cos' | 'tan' | 'asin' | 'acos' | 'atan' | 'sqrt' | 'exp';

export interface ExprUnary {
  kind: UnaryOp;
  child: ExprNode;
}

export interface ExprAtan2 {
  kind: 'atan2';
  y: ExprNode;
  x: ExprNode;
}

export interface ExprIfThen {
  kind: 'ifthen';
  cond: ExprNode;
  then: ExprNode;
  else: ExprNode;
}

export interface ExprSwitch {
  kind: 'switch';
  index: ExprNode;
  cases: ExprNode[];
  default: ExprNode;
}

export type ComparisonOp = 'gt' | 'lt' | 'ge' | 'le' | 'eq' | 'nq';

export interface ExprComparison {
  kind: ComparisonOp;
  left: ExprNode;
  right: ExprNode;
}

// Coefficient with expression tree
export interface AeroCoefficient {
  name: string;
  description: string;
  axis: string;
  expression: ExprNode;
}
