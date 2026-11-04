import { invoke } from '@tauri-apps/api/core';
export interface RuntimeEdit { key: string; value: number }
export interface RuntimeSnapshot { model: string; state: string; timestamp: number; age_ms: number; tuning: { version: number; session: string; request: number; status: string; values: number[] } }
export const runtimeSnapshot = (instance: number): Promise<RuntimeSnapshot | null> => invoke('sim_runtime_snapshot', { instanceId: instance });
export const runtimeApply = (instance: number, snapshot: RuntimeSnapshot, edits: RuntimeEdit[]): Promise<RuntimeSnapshot> => invoke('sim_runtime_apply', { instanceId: instance, session: snapshot.tuning.session, model: snapshot.model, edits });
