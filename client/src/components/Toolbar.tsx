import { useState, useRef } from 'react';
import { useFlowStore } from '../store/flowStore';
import AircraftWizard from './AircraftWizard';
import AircraftLibrary from './AircraftLibrary';

interface ToolbarProps {
  onShow3D?: () => void;
  onShowLive?: () => void;
}

export default function Toolbar({ onShow3D, onShowLive }: ToolbarProps) {
  const { aircraft, setAircraft, nodes, edges, loadProject, clearAll } = useFlowStore();
  const [showXml, setShowXml] = useState(false);
  const [xmlContent, setXmlContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportXml = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/generate-xml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aircraft, nodes, edges }),
      });
      if (!res.ok) throw new Error(`服务器错误 (${res.status})`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setXmlContent(data.xml);
      setShowXml(true);
    } catch (err: any) {
      alert('导出失败: ' + err.message);
    }
    setLoading(false);
  };

  const handleImportXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setLoading(true);
    try {
      // Read all files
      const allFiles: { name: string; xml: string }[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        const text = await f.text();
        allFiles.push({ name: f.name, xml: text });
      }

      // First file is the main XML, rest are referenced files
      const mainXml = allFiles[0].xml;
      const refFiles = allFiles.slice(1);

      const res = await fetch('/api/parse-xml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xml: mainXml, files: refFiles }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`服务器错误 (${res.status})${text ? ': ' + text : ''}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      loadProject(data);

      // Persist to localStorage so data survives refresh
      try {
        localStorage.setItem('jsbsim-project', JSON.stringify(data));
        localStorage.setItem('jsbsim-raw-xml', mainXml);
      } catch (e) {
        console.warn('[Import] Failed to save to localStorage:', e);
      }

      if (refFiles.length > 0) {
        console.log(`[Import] Merged ${refFiles.length} referenced file(s): ${refFiles.map(f => f.name).join(', ')}`);
      }
    } catch (err: any) {
      alert('导入失败: ' + err.message);
    }
    setLoading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSave = async () => {
    const filename = prompt('保存文件名:', 'project.json');
    if (!filename) return;
    try {
      await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, aircraft, nodes, edges }),
      });
      alert('保存成功!');
    } catch (err: any) {
      alert('保存失败: ' + err.message);
    }
  };

  const handleLoad = async () => {
    const filename = prompt('加载文件名:', 'project.json');
    if (!filename) return;
    try {
      const res = await fetch('/api/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) throw new Error(`文件不存在或服务器错误 (${res.status})`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      loadProject(data);
    } catch (err: any) {
      alert('加载失败: ' + err.message);
    }
  };

  const handleCopyXml = () => {
    navigator.clipboard.writeText(xmlContent);
  };

  const handleDownloadXml = () => {
    const blob = new Blob([xmlContent], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${aircraft.name.replace(/\s+/g, '_')}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <span className="toolbar-title">
            <img src="/favicon.svg" alt="logo" style={{ width: 22, height: 22, verticalAlign: 'middle', marginRight: 8 }} />
            JSBSim Visual Editor
          </span>
          <input
            className="aircraft-name-input"
            value={aircraft.name}
            onChange={e => setAircraft({ ...aircraft, name: e.target.value })}
            placeholder="飞机名称"
          />
        </div>
        <div className="toolbar-center">
          <button onClick={() => { clearAll(); localStorage.removeItem('jsbsim-project'); localStorage.removeItem('jsbsim-raw-xml'); }} disabled={loading}>📄 新建</button>
          <button onClick={() => setShowWizard(true)} disabled={loading}>🪄 创建向导</button>
          <button onClick={() => setShowLibrary(true)} disabled={loading}>📚 模型库</button>
          <button onClick={handleSave} disabled={loading}>💾 保存</button>
          <button onClick={handleLoad} disabled={loading}>📂 加载</button>
        </div>
        <div className="toolbar-right">
          <button className="btn-live" onClick={onShowLive} title="实时融合显示">
            🔴 实时
          </button>
          <button className="btn-3d" onClick={onShow3D} title="3D 预览">
            🛩️ 3D
          </button>
          <button className="btn-import" onClick={() => fileInputRef.current?.click()} disabled={loading} title="导入XML文件（自动从JSBSim目录解析引用文件）">
            📥 导入XML
          </button>
          <input ref={fileInputRef} type="file" accept=".xml" multiple onChange={handleImportXml} style={{ display: 'none' }} />
          <button className="btn-export" onClick={handleExportXml} disabled={loading}>
            {loading ? '⏳ 处理中...' : '📤 导出XML'}
          </button>
        </div>
      </div>

      {showXml && (
        <div className="xml-modal-overlay" onClick={() => setShowXml(false)}>
          <div className="xml-modal" onClick={e => e.stopPropagation()}>
            <div className="xml-modal-header">
              <h3>生成的 JSBSim XML</h3>
              <div className="xml-modal-actions">
                <button onClick={handleCopyXml}>📋 复制</button>
                <button onClick={handleDownloadXml}>💾 下载</button>
                <button onClick={() => setShowXml(false)}>✖ 关闭</button>
              </div>
            </div>
            <textarea className="xml-content" readOnly value={xmlContent} />
          </div>
        </div>
      )}

      {showWizard && (
        <AircraftWizard
          onClose={() => setShowWizard(false)}
          onGenerate={async (xml) => {
            try {
              const res = await fetch('/api/parse-xml', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ xml }),
              });
              if (!res.ok) throw new Error(`服务器错误 (${res.status})`);
              const data = await res.json();
              if (data.error) throw new Error(data.error);
              loadProject(data);
              setShowWizard(false);
            } catch (err: any) {
              alert('导入失败: ' + err.message);
            }
          }}
        />
      )}

      {showLibrary && (
        <AircraftLibrary
          onClose={() => setShowLibrary(false)}
          onLoad={(data) => {
            loadProject(data);
            // Persist to localStorage
            try {
              localStorage.setItem('jsbsim-project', JSON.stringify(data));
              localStorage.setItem('jsbsim-cache-version', '2');
            } catch (e) { /* ignore */ }
          }}
        />
      )}
    </>
  );
}
