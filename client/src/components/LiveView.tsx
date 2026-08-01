import { useSimSocket } from '../sim/useSimSocket';
import Live3D from './Live3D';
import LivePanel from './LivePanel';

interface LiveViewProps {
  onClose: () => void;
}

export default function LiveView({ onClose }: LiveViewProps) {
  const { telemetry, connected, sendControl } = useSimSocket();

  return (
    <div className="live-overlay">
      <div className="live-topbar">
        <span className="live-title">🔴 实时融合显示</span>
        <span className="live-sub">JSBSim · 真机飞控 · 上位机</span>
        <button className="live-close" onClick={onClose}>← 返回编辑器</button>
      </div>
      <div className="live-body">
        <div className="live-canvas">
          <Live3D telemetry={telemetry} />
        </div>
        <div className="live-side">
          <LivePanel telemetry={telemetry} connected={connected} onControl={sendControl} />
        </div>
      </div>
    </div>
  );
}
