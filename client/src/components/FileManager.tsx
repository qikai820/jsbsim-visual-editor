import { useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import type { SubFileType } from '../types';

export default function FileManager() {
  const { subFiles, addSubFile, removeSubFile, setEditingSubFile, editingSubFileId } = useFlowStore();
  const [addingType, setAddingType] = useState<SubFileType | null>(null);
  const [newFileName, setNewFileName] = useState('');

  const sections: { type: SubFileType; label: string; icon: string }[] = [
    { type: 'engine', label: '发动机 Engines', icon: '⚙️' },
    { type: 'thruster', label: '推力器 Thrusters', icon: '🔄' },
    { type: 'system', label: '系统 Systems', icon: '🔗' },
  ];

  const handleAdd = (type: SubFileType) => {
    if (!newFileName.trim()) return;
    addSubFile(type, newFileName.trim());
    setNewFileName('');
    setAddingType(null);
  };

  return (
    <div className="file-manager">
      <h3>文件管理 Files</h3>
      {sections.map(section => {
        const files = subFiles.filter(f => f.fileType === section.type);
        return (
          <div key={section.type} className="fm-section">
            <div className="fm-section-header">
              <span className="fm-section-title">{section.icon} {section.label}</span>
              <button className="fm-add-btn" onClick={() => { setAddingType(section.type); setNewFileName(''); }}>+ 添加</button>
            </div>
            {addingType === section.type && (
              <div className="fm-add-row">
                <input
                  className="fm-add-input"
                  value={newFileName}
                  onChange={e => setNewFileName(e.target.value)}
                  placeholder="文件名 (如 engIO360)"
                  onKeyDown={e => e.key === 'Enter' && handleAdd(section.type)}
                  autoFocus
                />
                <button onClick={() => handleAdd(section.type)}>✓</button>
                <button onClick={() => setAddingType(null)}>✗</button>
              </div>
            )}
            {files.map(file => (
              <div
                key={file.id}
                className={`fm-file-item ${editingSubFileId === file.id ? 'active' : ''}`}
                onClick={() => setEditingSubFile(file.id)}
              >
                <span className="fm-file-name">{file.fileName}</span>
                <div className="fm-actions">
                  <button className="fm-edit-btn" onClick={e => { e.stopPropagation(); setEditingSubFile(file.id); }}>✏️</button>
                  <button className="fm-delete-btn" onClick={e => { e.stopPropagation(); removeSubFile(file.id); }}>🗑️</button>
                </div>
              </div>
            ))}
            {files.length === 0 && <div className="fm-empty">暂无文件</div>}
          </div>
        );
      })}
    </div>
  );
}
