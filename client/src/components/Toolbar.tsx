import { useState, useRef } from 'react';
import { useFlowStore } from '../store/flowStore';

export default function Toolbar() {
  const { aircraft, setAircraft, nodes, edges, loadProject, clearAll } = useFlowStore();
  const [showXml, setShowXml] = useState(false);
  const [xmlContent, setXmlContent] = useState('');
  const [loading, setLoading] = useState(false);
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
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const xml = await file.text();
      const res = await fetch('/api/parse-xml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xml }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`服务器错误 (${res.status})${text ? ': ' + text : ''}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      loadProject(data);
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
          <span className="toolbar-title">✈️ JSBSim Visual Editor</span>
          <input
            className="aircraft-name-input"
            value={aircraft.name}
            onChange={e => setAircraft({ ...aircraft, name: e.target.value })}
            placeholder="飞机名称"
          />
        </div>
        <div className="toolbar-center">
          <button onClick={() => { clearAll(); }} disabled={loading}>📄 新建</button>
          <button onClick={handleSave} disabled={loading}>💾 保存</button>
          <button onClick={handleLoad} disabled={loading}>📂 加载</button>
        </div>
        <div className="toolbar-right">
          <button className="btn-import" onClick={() => fileInputRef.current?.click()} disabled={loading}>
            📥 导入XML
          </button>
          <input ref={fileInputRef} type="file" accept=".xml" onChange={handleImportXml} style={{ display: 'none' }} />
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
    </>
  );
}
