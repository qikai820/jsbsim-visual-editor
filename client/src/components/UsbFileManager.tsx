import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useLanguage } from '../i18n';
import {
  isTauri, usbFileDelete, usbFileDownload, usbFileList, usbFileMkdir,
  usbFileEditSessions, usbFileFinishEditor, usbFileOpenEditor, usbFileSaveEditor,
  usbFileTransfer, usbFileUploadLocal, usbFileWrite, type UsbEditorSession, type UsbFileEntry,
} from '../utils/tauriApi';
import './UsbFileManager.css';

type Volume = 'sd' | 'data';
const DOWNLOAD_DIRECTORY_KEY = 'jsbsim-usb-download-directory';
const UPLOAD_PATH_KEY = 'jsbsim-usb-upload-path';

function formatSize(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GiB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[\\/\0:*?"<>|\x01-\x1f]/.test(name) &&
    new TextEncoder().encode(name).length <= 32;
}

type Clipboard = { source: string; move: boolean };
type ContextMenu = { x: number; y: number; entry: UsbFileEntry | null };

export default function UsbFileManager({ onClose }: { onClose: () => void }) {
  const { isZh } = useLanguage();
  const [volume, setVolume] = useState<Volume>('sd');
  const [segments, setSegments] = useState<string[]>([]);
  const [entries, setEntries] = useState<UsbFileEntry[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [folderName, setFolderName] = useState('');
  const [renameName, setRenameName] = useState<string | null>(null);
  const [renameSource, setRenameSource] = useState('');
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [pasteName, setPasteName] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [editorSessions, setEditorSessions] = useState<UsbEditorSession[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const refreshNotice = useRef('');
  const directory = [volume, ...segments].join('/');
  useEffect(() => { setRenameName(null); setContextMenu(null); }, [directory]);
  useEffect(() => {
    if (!contextMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setContextMenu(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [contextMenu]);
  const selectedEntry = entries.find(entry => entry.name === selected);
  const nativePicker = isTauri && /Linux/i.test(navigator.userAgent);

  useEffect(() => {
    if (!isTauri) return;
    void usbFileEditSessions().then(setEditorSessions).catch(error =>
      setStatus(`${isZh ? '读取编辑会话失败' : 'Could not restore editor sessions'}: ${errorText(error)}`));
  }, [isZh]);

  const refresh = useCallback((notice = '') => {
    refreshNotice.current = notice;
    setRevision(value => value + 1);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const notice = refreshNotice.current;
    refreshNotice.current = '';
    setSelected('');
    setLoading(true);
    setStatus(isZh ? '正在读取目录…' : 'Loading directory…');
    void usbFileList(directory).then(files => {
      if (cancelled) return;
      setEntries(files.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name)));
      setStatus(notice || (files.length ? '' : (isZh ? '目录为空' : 'Directory is empty')));
    }).catch(error => {
      if (cancelled) return;
      setEntries([]);
      setStatus(`${isZh ? '读取失败' : 'Could not list files'}: ${errorText(error)}`);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [directory, isZh, revision]);

  const chooseVolume = (next: Volume) => {
    if (busy) return;
    setVolume(next);
    setSegments([]);
  };
  const openDirectory = (name: string) => {
    if (busy) return;
    setSegments(value => [...value, name]);
  };
  const createFolder = async () => {
    const name = folderName.trim();
    if (!validName(name)) {
      setStatus(isZh ? '目录名需为 1–32 字节，且不能包含斜杠' : 'Folder name must be 1–32 bytes without slashes');
      return;
    }
    setBusy(true);
    try {
      await usbFileMkdir(`${directory}/${name}`);
      setFolderName('');
      refresh(isZh ? `已创建 ${name}` : `Created ${name}`);
    } catch (error) { setStatus(`${isZh ? '创建失败' : 'Could not create folder'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const upload = async () => {
    if (!nativePicker) { fileInput.current?.click(); return; }
    setBusy(true);
    setStatus(isZh ? '请选择要上传的文件…' : 'Choose a file to upload…');
    try {
      const previous = localStorage.getItem(UPLOAD_PATH_KEY) || undefined;
      const result = await usbFileUploadLocal(directory, previous);
      if (result) {
        localStorage.setItem(UPLOAD_PATH_KEY, result.localPath);
        refresh(`${isZh ? '已上传' : 'Uploaded'} ${result.remotePath} (${formatSize(result.size)})`);
      } else setStatus('');
    } catch (error) { setStatus(`${isZh ? '上传失败' : 'Upload failed'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const uploadBrowserFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 16 * 1024 * 1024) {
          throw new Error(isZh ? '此平台通过文件选择框上传限 16 MiB' : 'Browser upload is limited to 16 MiB on this platform');
        }
        setStatus(`${isZh ? '正在上传' : 'Uploading'} ${file.name}…`);
        await usbFileWrite(`${directory}/${file.name}`, new Uint8Array(await file.arrayBuffer()));
      }
      refresh(isZh ? `已上传 ${files.length} 个文件` : `Uploaded ${files.length} file(s)`);
    } catch (error) { setStatus(`${isZh ? '上传失败' : 'Upload failed'}: ${errorText(error)}`); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  const download = async (entry = selectedEntry) => {
    if (!entry || entry.directory) return;
    setBusy(true);
    setStatus(isZh ? `正在下载 ${entry.name}…` : `Downloading ${entry.name}…`);
    try {
      const target = localStorage.getItem(DOWNLOAD_DIRECTORY_KEY) || '~/Downloads/JSBSim-Files';
      const result = await usbFileDownload(`${directory}/${entry.name}`, target);
      setStatus(`${isZh ? '已保存到' : 'Saved to'} ${result.localPath}`);
    } catch (error) { setStatus(`${isZh ? '下载失败' : 'Download failed'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const openEditor = async (entry = selectedEntry) => {
    if (!entry || entry.directory) return;
    setBusy(true);
    setStatus(isZh ? `正在准备 ${entry.name}…` : `Preparing ${entry.name}…`);
    try {
      const target = localStorage.getItem(DOWNLOAD_DIRECTORY_KEY) || '~/Downloads/JSBSim-Files';
      const session = await usbFileOpenEditor(`${directory}/${entry.name}`, target);
      if (session) {
        setEditorSessions(previous => [...previous, session]);
        setStatus(isZh
          ? `已使用 ${session.application} 打开本地副本；编辑后点“保存回仿真机”`
          : `Opened a local copy with ${session.application}; save it back after editing`);
      } else setStatus('');
    } catch (error) { setStatus(`${isZh ? '打开失败' : 'Could not open'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const saveEditor = async (session: UsbEditorSession) => {
    setBusy(true);
    setStatus(isZh ? `正在保存 ${session.remotePath}…` : `Saving ${session.remotePath}…`);
    try {
      const result = await usbFileSaveEditor(session.id);
      if (result.changed) refresh(isZh ? `已保存回 ${session.remotePath}` : `Saved back to ${session.remotePath}`);
      else setStatus(isZh ? '本地副本尚未修改' : 'Local copy has not changed');
    } catch (error) { setStatus(`${isZh ? '保存失败' : 'Save failed'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const finishEditor = async (session: UsbEditorSession) => {
    setBusy(true);
    try {
      await usbFileFinishEditor(session.id);
      setEditorSessions(previous => previous.filter(item => item.id !== session.id));
      setStatus(isZh ? '编辑记录已移除；本地副本仍保留' : 'Editor session removed; local copy remains');
    } catch (error) { setStatus(`${isZh ? '结束编辑失败' : 'Could not finish editing'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const remove = async (entry = selectedEntry) => {
    if (!entry) return;
    const question = entry.directory
      ? (isZh ? `删除空目录“${entry.name}”？` : `Delete empty folder “${entry.name}”?`)
      : (isZh ? `永久删除文件“${entry.name}”？` : `Permanently delete “${entry.name}”?`);
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      await usbFileDelete(`${directory}/${entry.name}`);
      setSelected('');
      refresh(isZh ? '已删除' : 'Deleted');
    } catch (error) { setStatus(`${isZh ? '删除失败' : 'Delete failed'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };

  const rename = async () => {
    if (!renameSource || renameName === null) return;
    const name = renameName.trim();
    if (!validName(name)) {
      setStatus(isZh ? '名称需为 1–32 字节，且不能包含斜杠' : 'Name must be 1–32 bytes without slashes');
      return;
    }
    if (name === renameSource.split('/').pop()) { setRenameName(null); return; }
    setBusy(true);
    try {
      await usbFileTransfer(renameSource, `${renameSource.slice(0, renameSource.lastIndexOf('/'))}/${name}`, true);
      setRenameName(null);
      setRenameSource('');
      refresh(isZh ? `已重命名为 ${name}` : `Renamed to ${name}`);
    } catch (error) { setStatus(`${isZh ? '重命名失败' : 'Rename failed'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const beginRename = (entry: UsbFileEntry) => {
    setRenameName(entry.name);
    setRenameSource(`${directory}/${entry.name}`);
  };
  const markTransfer = (move: boolean, entry = selectedEntry) => {
    if (!entry) return;
    setClipboard({ source: `${directory}/${entry.name}`, move });
    setPasteName(entry.name);
    setRenameName(null);
    setStatus(move
      ? (isZh ? '已选择移动；进入目标目录后点“粘贴”' : 'Move selected; open the destination and paste')
      : (isZh ? '已选择拷贝；进入目标目录后点“粘贴”' : 'Copy selected; open the destination and paste'));
  };
  const paste = async (targetDirectory = directory) => {
    if (!clipboard) return;
    const name = pasteName.trim();
    if (!validName(name)) {
      setStatus(isZh ? '目标名称需为 1–32 字节，且不能包含斜杠' : 'Target name must be 1–32 bytes without slashes');
      return;
    }
    const destination = `${targetDirectory}/${name}`;
    if (targetDirectory === directory && entries.some(entry => entry.name === name)) {
      setStatus(isZh ? '目标位置已有同名文件或目录' : 'A file or folder with that name already exists');
      return;
    }
    setBusy(true);
    setStatus(clipboard.move ? (isZh ? '正在移动…' : 'Moving…') : (isZh ? '正在拷贝…' : 'Copying…'));
    try {
      await usbFileTransfer(clipboard.source, destination, clipboard.move);
      const notice = clipboard.move ? (isZh ? '移动完成' : 'Move complete') : (isZh ? '拷贝完成' : 'Copy complete');
      setClipboard(null);
      setPasteName('');
      refresh(notice);
    } catch (error) { setStatus(`${isZh ? '操作失败' : 'Operation failed'}: ${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const showContextMenu = (event: MouseEvent, entry: UsbFileEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    if (entry) setSelected(entry.name);
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 260)),
      entry,
    });
  };

  return <div className="usb-fm" role="dialog" aria-modal="true" aria-label={isZh ? '仿真机文件管理' : 'Simulator Files'}>
    <header className="usb-fm-header">
      <div><strong>🗂 {isZh ? '仿真机文件管理' : 'Simulator Files'}</strong><small>{isZh ? '通过 USB 管理 SD 与 data' : 'Manage SD and data over USB'}</small></div>
      <button onClick={onClose} aria-label={isZh ? '关闭' : 'Close'}>×</button>
    </header>
    <div className="usb-fm-volumes">
      <button className={volume === 'sd' ? 'active' : ''} onClick={() => chooseVolume('sd')} disabled={busy}>SD</button>
      <button className={volume === 'data' ? 'active' : ''} onClick={() => chooseVolume('data')} disabled={busy}>data</button>
    </div>
    <nav className="usb-fm-breadcrumb" aria-label={isZh ? '当前路径' : 'Current path'}>
      <button onClick={() => setSegments([])} disabled={busy}>{volume}</button>
      {segments.map((part, index) => <span key={`${index}-${part}`}>
        <b>/</b><button onClick={() => setSegments(segments.slice(0, index + 1))} disabled={busy}>{part}</button>
      </span>)}
    </nav>
    <div className="usb-fm-toolbar">
      <button onClick={() => refresh()} disabled={busy || loading}>↻ {isZh ? '刷新' : 'Refresh'}</button>
      <button onClick={() => void upload()} disabled={busy || loading}>↑ {isZh ? '上传文件' : 'Upload'}</button>
      <button onClick={() => void openEditor()} disabled={busy || !selectedEntry || selectedEntry.directory}>↗ {isZh ? '打开' : 'Open'}</button>
      <button onClick={() => void download()} disabled={busy || !selectedEntry || selectedEntry.directory}>↓ {isZh ? '下载' : 'Download'}</button>
      <button onClick={() => selectedEntry && beginRename(selectedEntry)} disabled={busy || !selectedEntry}>✎ {isZh ? '重命名' : 'Rename'}</button>
      <button onClick={() => markTransfer(false)} disabled={busy || !selectedEntry}>⧉ {isZh ? '拷贝' : 'Copy'}</button>
      <button onClick={() => markTransfer(true)} disabled={busy || !selectedEntry}>✂ {isZh ? '移动' : 'Move'}</button>
      <button onClick={() => void remove()} disabled={busy || !selectedEntry}>🗑 {isZh ? '删除' : 'Delete'}</button>
      <input ref={fileInput} type="file" multiple hidden onChange={event => void uploadBrowserFiles(event.target.files)} />
    </div>
    {renameName !== null && <div className="usb-fm-action">
      <label>{isZh ? '新名称' : 'New name'} <input value={renameName} autoFocus onChange={event => setRenameName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(); if (event.key === 'Escape') setRenameName(null); }} disabled={busy} /></label>
      <button onClick={() => void rename()} disabled={busy || !validName(renameName.trim())}>{isZh ? '确定' : 'Rename'}</button>
      <button onClick={() => setRenameName(null)} disabled={busy}>{isZh ? '取消' : 'Cancel'}</button>
    </div>}
    {clipboard && <div className="usb-fm-action">
      <span>{clipboard.move ? (isZh ? '移动' : 'Move') : (isZh ? '拷贝' : 'Copy')}: {clipboard.source} → {directory}/</span>
      <label>{isZh ? '目标名称' : 'Target name'} <input value={pasteName} onChange={event => setPasteName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void paste(); }} disabled={busy} /></label>
      <button onClick={() => void paste()} disabled={busy || loading || !validName(pasteName.trim())}>{isZh ? '粘贴' : 'Paste'}</button>
      <button onClick={() => setClipboard(null)} disabled={busy}>{isZh ? '取消' : 'Cancel'}</button>
    </div>}
    {editorSessions.length > 0 && <div className="usb-fm-edit-sessions" aria-label={isZh ? '电脑编辑记录' : 'Computer editor sessions'}>
      {editorSessions.map(session => <div className="usb-fm-edit-session" key={session.id}>
        <div><strong>{session.remotePath}</strong><small>{session.application} · {session.localPath}</small></div>
        <button onClick={() => void saveEditor(session)} disabled={busy}>{isZh ? '保存回仿真机' : 'Save to simulator'}</button>
        <button onClick={() => void finishEditor(session)} disabled={busy} title={isZh ? '只移除记录，本地副本保留' : 'Remove session; keep local copy'}>{isZh ? '移除记录' : 'Remove session'}</button>
      </div>)}
      <small>{isZh ? '电脑编辑器保存的是本地副本；点“保存回仿真机”才会更新设备文件。' : 'The editor saves a local copy; use “Save to simulator” to update the device.'}</small>
    </div>}
    <div className="usb-fm-list" role="listbox" aria-label={isZh ? '文件列表' : 'Files'} onContextMenu={event => showContextMenu(event, null)}>
      {segments.length > 0 && <button className="usb-fm-row" onClick={() => setSegments(value => value.slice(0, -1))} disabled={busy}><span>↰</span><strong>..</strong><small /></button>}
      {entries.map(entry => <button key={entry.name} className={`usb-fm-row ${selected === entry.name ? 'selected' : ''}`}
        onClick={() => setSelected(entry.name)} onDoubleClick={() => entry.directory && openDirectory(entry.name)} onContextMenu={event => showContextMenu(event, entry)} disabled={busy} role="option" aria-selected={selected === entry.name}>
        <span>{entry.directory ? '📁' : '📄'}</span><strong>{entry.name}</strong><small>{entry.directory ? '' : formatSize(entry.size)}</small>
        {entry.directory && <span className="usb-fm-open" onClick={event => { event.stopPropagation(); openDirectory(entry.name); }}>›</span>}
      </button>)}
      {!loading && entries.length === 0 && <div className="usb-fm-empty">{status || (isZh ? '目录为空' : 'Directory is empty')}</div>}
    </div>
    <footer className="usb-fm-footer">
      <label>{isZh ? '新建目录' : 'New folder'} <input ref={folderInput} value={folderName} onChange={event => setFolderName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void createFolder(); }} placeholder={isZh ? '目录名' : 'Folder name'} disabled={busy} /></label>
      <button onClick={() => void createFolder()} disabled={busy || !folderName.trim()}>{isZh ? '创建' : 'Create'}</button>
      <span aria-live="polite">{loading ? (isZh ? '读取中…' : 'Loading…') : status}</span>
    </footer>
    {contextMenu && <div className="usb-fm-context-overlay" onMouseDown={() => setContextMenu(null)} onContextMenu={event => { event.preventDefault(); setContextMenu(null); }}>
      <div className="usb-fm-context" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={event => event.stopPropagation()}>
        {contextMenu.entry ? <>
          {contextMenu.entry.directory
            ? <button role="menuitem" onClick={() => { openDirectory(contextMenu.entry!.name); setContextMenu(null); }}>{isZh ? '打开文件夹' : 'Open folder'}</button>
            : <>
              <button role="menuitem" onClick={() => { void openEditor(contextMenu.entry!); setContextMenu(null); }}>{isZh ? '使用电脑编辑器打开…' : 'Open with computer editor…'}</button>
              <button role="menuitem" onClick={() => { void download(contextMenu.entry!); setContextMenu(null); }}>{isZh ? '下载' : 'Download'}</button>
            </>}
          <button role="menuitem" onClick={() => { beginRename(contextMenu.entry!); setContextMenu(null); }}>{isZh ? '重命名' : 'Rename'}</button>
          <button role="menuitem" onClick={() => { markTransfer(false, contextMenu.entry!); setContextMenu(null); }}>{isZh ? '拷贝' : 'Copy'}</button>
          <button role="menuitem" onClick={() => { markTransfer(true, contextMenu.entry!); setContextMenu(null); }}>{isZh ? '移动' : 'Move'}</button>
          {contextMenu.entry.directory && clipboard && <button role="menuitem" onClick={() => { void paste(`${directory}/${contextMenu.entry!.name}`); setContextMenu(null); }}>{isZh ? '粘贴到此文件夹' : 'Paste into folder'}</button>}
          <div className="usb-fm-context-separator" />
          <button role="menuitem" onClick={() => { void remove(contextMenu.entry!); setContextMenu(null); }}>{isZh ? '删除' : 'Delete'}</button>
        </> : <>
          <button role="menuitem" onClick={() => { void paste(); setContextMenu(null); }} disabled={!clipboard || loading}>{isZh ? '粘贴到此目录' : 'Paste here'}</button>
          <button role="menuitem" onClick={() => { folderInput.current?.focus(); setContextMenu(null); }}>{isZh ? '新建目录' : 'New folder'}</button>
          <div className="usb-fm-context-separator" />
          <button role="menuitem" onClick={() => { refresh(); setContextMenu(null); }}>{isZh ? '刷新' : 'Refresh'}</button>
        </>}
      </div>
    </div>}
  </div>;
}
