import type { Telemetry } from '../sim/useSimSocket';
import { formatValueWithUnit, type UnitSystem } from '../utils/unitConversion';

interface DashboardProps {
  telemetry: Telemetry | null;
  pinnedPaths: string[];
  onUnpin: (path: string) => void;
  unitSystem: UnitSystem;
}

export default function Dashboard({ telemetry, pinnedPaths, onUnpin, unitSystem }: DashboardProps) {
  if (pinnedPaths.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>📌</div>
        <div>从左侧属性树中点击 ☆ 固定属性到此面板</div>
      </div>
    );
  }

  return (
    <div className="dashboard" style={{ padding: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
        固定属性 ({pinnedPaths.length})
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
        {pinnedPaths.map(path => {
          const value = telemetry?.[path];
          const { value: formattedValue, unit } = formatValueWithUnit(value, path, unitSystem);
          return (
            <div
              key={path}
              className="dashboard-card"
              style={{
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 12px',
                position: 'relative',
              }}
            >
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', marginBottom: 4, wordBreak: 'break-all' }}>
                {path}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{ fontSize: 20, fontWeight: 'bold', color: 'var(--success)', fontFamily: 'monospace' }}>
                  {formattedValue}
                </span>
                {unit && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{unit}</span>}
              </div>
              <button
                onClick={() => onUnpin(path)}
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: 14,
                  padding: '2px 6px',
                }}
                title="取消固定"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
