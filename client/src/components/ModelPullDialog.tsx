import { useEffect, useRef, useState } from 'react';
import { simListModels } from '../utils/tauriApi';
import { useLanguage } from '../i18n';
import './ModelPullDialog.css';

interface Props {
  initialModel: string;
  onPull: (model: string) => Promise<void>;
  onClose: () => void;
}

export default function ModelPullDialog({ initialModel, onPull, onClose }: Props) {
  const { isZh } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(initialModel);
  const [listing, setListing] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let canceled = false;
    setListing(true);
    setError('');
    void simListModels().then(items => {
      if (canceled) return;
      const names = [...new Set(items.map(item => String(item.name || '')).filter(Boolean))].sort();
      setModels(names);
      setModel(current => names.includes(current) ? current : names[0] || '');
    }).catch(error => { if (!canceled) setError(error.message || String(error)); })
      .finally(() => { if (!canceled) setListing(false); });
    return () => { canceled = true; };
  }, [attempt]);
  const pull = async () => {
    setPulling(true);
    setError('');
    try { await onPull(model); }
    catch (error: any) { setError(error.message || String(error)); }
    finally { setPulling(false); }
  };
  return <dialog ref={dialog} className="model-pull-dialog" aria-labelledby="model-pull-title"
    onCancel={event => { event.preventDefault(); if (!pulling) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="model-pull-title">{isZh ? '从仿真机拉取模型' : 'Pull model from simulator'}</h2>
      <button type="button" disabled={pulling} aria-label={isZh ? '关闭拉取模型' : 'Close model pull'} onClick={onClose}>×</button></header>
    <div className="model-pull-body">
      <p>{isZh ? '选择仿真机上的模型。拉取完成后先查看差异，再确认是否覆盖上位机当前模型。' : 'Choose a simulator model. Review the differences before replacing the current editor model.'}</p>
      <label>{isZh ? '仿真机模型' : 'Simulator model'}
        <select value={model} disabled={listing || pulling || !models.length} onChange={event => setModel(event.target.value)}>
          {!models.length && <option value="">{listing ? (isZh ? '正在读取模型列表…' : 'Reading models…') : (isZh ? '无可用模型' : 'No models available')}</option>}
          {models.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      {pulling && <p role="status">{isZh ? '正在读取完整模型、引用文件及模型配置…' : 'Reading the model, referenced files and model configuration…'}</p>}
      {error && <p className="model-pull-error" role="alert">{error}</p>}
    </div>
    <footer>
      <button type="button" disabled={pulling} onClick={onClose}>{isZh ? '取消' : 'Cancel'}</button>
      <button type="button" disabled={listing || pulling} onClick={() => setAttempt(value => value + 1)}>{isZh ? '刷新列表' : 'Refresh'}</button>
      <button type="button" className="primary" disabled={listing || pulling || !model} onClick={() => void pull()}>
        {pulling ? (isZh ? '正在拉取…' : 'Pulling…') : (isZh ? '拉取并对比' : 'Pull and compare')}
      </button>
    </footer>
  </dialog>;
}
