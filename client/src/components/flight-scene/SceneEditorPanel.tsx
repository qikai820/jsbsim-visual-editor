import { useEffect, useRef, useState } from 'react';
import type { SceneEditor } from './useSceneEditor';
import type { SceneModelOrigin } from './useSceneModelOrigin';
import { defaultSceneTransform, MAX_VISUAL_GROUND_OFFSET_M, sceneObjectVisible, type Triple } from '../../sim/sceneDocument';
import { isTauri } from '../../utils/tauriApi';

function NumberField({ label, value, min = -1e7, max = 1e7, digits = 4, step = .1, onChange }: {
  label: string; value?: number; min?: number; max?: number; digits?: number; step?: number; onChange: (n: number) => void;
}) {
  const formatted = value === undefined ? '' : String(Number(value.toFixed(digits)));
  const [draft, setDraft] = useState(formatted);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (document.activeElement !== input.current) setDraft(formatted); }, [formatted]);
  return <input ref={input} aria-label={label} type="number" step={step} min={min} max={max} value={draft} placeholder="等待模型配置"
    onChange={event => { setDraft(event.target.value); const n = event.target.valueAsNumber;
      if (Number.isFinite(n) && n >= min && n <= max) onChange(n); }}
    onBlur={() => setDraft(formatted)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
}

export default function SceneEditorPanel({ model, modelOrigin, sceneLoaded, sceneRevision, sceneContacts, editor, groundAltitude, onGroundLoaded, onCollapse }: {
  model: string; sceneLoaded: number | null; sceneRevision: number | null; sceneContacts: number | null;
  modelOrigin?: SceneModelOrigin;
  editor: SceneEditor; groundAltitude: number | null; onGroundLoaded: (altitude: number | null) => void;
  onCollapse?: () => void;
}) {
  const modelInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null), sceneInput = useRef<HTMLInputElement>(null);
  const [onlineUrl, setOnlineUrl] = useState(''), [replaceScenery, setReplaceScenery] = useState(true);
  const selected = editor.document.objects.find(object => object.id === editor.selectedId);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !list.current) return;
    const bounds = list.current.getBoundingClientRect(), item = row.getBoundingClientRect();
    if (item.top < bounds.top) list.current.scrollTop -= bounds.top - item.top;
    if (item.bottom > bounds.bottom) list.current.scrollTop += item.bottom - bounds.bottom;
  }, [editor.selectedId]);
  useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', ''); }, []);
  return <aside className="scene-inspector scene-editor" aria-label="场景编辑器">
    <header><strong>场景编辑</strong><div className="scene-panel-buttons"><button className="scene-action" disabled={editor.busy} onClick={() => editor.save(groundAltitude)}>保存</button><button className="scene-action" onClick={() => editor.setEnabled(false)}>完成</button>{onCollapse && <button className="scene-action" onClick={onCollapse} aria-label="收起场景属性">收起</button>}</div></header>
    {editor.busy && <div className="scene-editor-message"><p role="status">{editor.busyMessage}</p>
      {editor.canCancel && <button className="scene-action" onClick={editor.cancel}>取消加载</button>}</div>}
    {editor.error && <p className="scene-editor-message scene-editor-error" role="alert">{editor.error}</p>}
    {editor.notice && <p className="scene-editor-message" role="status">{editor.notice}</p>}
    <fieldset disabled={editor.busy}>
      {selected && <section>
        <label className="scene-editor-name">物体名称<input aria-label="物体名称" maxLength={200} value={selected.name} onChange={event => editor.updateObject(selected.id, { name: event.target.value })} /></label>
        {selected.builtin === 'f35' && <p className="scene-muted">F-35A 写实模型，起落架已放下。作者 shangus930 · CC BY 4.0；可独立调整停放位置。</p>}
        {selected.builtin === 'windsock' && <p className="scene-muted">风袋使用所选飞机实例的总环境风，袋尾朝下风向；风速、阵风与湍流驱动外形。布料鼓起和飘动为示意，未做风速标定。碰撞开启时只导出固定底座和立杆。</p>}
        <div className="scene-editor-actions scene-transform-modes">{(['translate', 'rotate', 'scale'] as const).map((mode, index) => <button key={mode}
          className={`scene-action ${editor.transformMode === mode ? 'active' : ''}`} aria-pressed={editor.transformMode === mode} onClick={() => editor.setTransformMode(mode)}>{['移动', '旋转', '缩放'][index]}</button>)}</div>
        {(['position', 'rotation', 'scale'] as const).map((key, index) => <div className="scene-transform-field" key={key}>
          <strong>{['位置 / m', '旋转 / °', '缩放倍数'][index]}</strong><div>{(['X', 'Y', 'Z'] as const).map((axis, i) => <label key={axis}><span>{axis}</span>
            <NumberField label={`${['位置', '旋转', '缩放'][index]} ${axis}`} value={selected[key][i]} min={key === 'scale' ? .001 : -1e7}
              onChange={value => { const triple = [...selected[key]] as Triple; triple[i] = value; editor.updateObject(selected.id, { [key]: triple }); }} />
          </label>)}</div>
        </div>)}
        <label className="scene-editor-check"><input type="checkbox" checked={selected.visible} onChange={event => editor.updateObject(selected.id, { visible: event.target.checked })} />显示物体</label>
        <label className="scene-editor-check"><input type="checkbox" checked={selected.collision !== false} onChange={event => editor.updateObject(selected.id, { collision: event.target.checked })} />参与仿真碰撞（重新导出后生效）</label>
        {selected.builtin && selected.builtin !== 'windsock' && !editor.document.showBase && <p className="scene-muted">默认试验场已隐藏，开启后可在视窗中编辑此物体。</p>}
        <div className="scene-editor-actions"><button className="scene-action" disabled={!sceneObjectVisible(selected, editor.document.showBase)} onClick={editor.focus}>定位物体</button>
          {selected.builtin === 'windsock' && <button className="scene-action" disabled={editor.document.objects.length >= 1000} onClick={() => editor.copyWindsock(selected.id)}>复制风袋</button>}
          <button className="scene-action" onClick={() => editor.updateObject(selected.id, defaultSceneTransform(selected))}>重置变换</button>
          <button className="scene-action scene-object-delete" onClick={() => editor.removeObject(selected.id)}>删除物体</button></div>
        <p className="scene-muted">拖动三轴手柄编辑，或输入数值。X 向东、Y 向上、Z 向南，位置相对场景原点的参考地面；旋转顺序 XYZ。变换会用于下一次碰撞地图导出。</p>
      </section>}
      <details className="scene-editor-section"><summary>场景与资源</summary>
        <label className="scene-editor-name">场景名称<input aria-label="场景名称" maxLength={200} value={editor.document.name} onChange={event => editor.updateDocument({ name: event.target.value })} /></label>
        <div className="scene-editor-actions">
          <button className="scene-action" disabled={editor.document.objects.length >= 1000} onClick={editor.addWindsock}>添加机场风袋</button>
          <button className="scene-action" onClick={() => modelInput.current?.click()}>导入 GLB/glTF</button>
          <button className="scene-action" onClick={() => {
            if (isTauri && /Linux/i.test(navigator.userAgent)) void editor.importDirectory();
            else folderInput.current?.click();
          }}>导入目录</button>
          <button className="scene-action" onClick={() => editor.save(groundAltitude)}>保存场景</button>
          <button className="scene-action" onClick={() => sceneInput.current?.click()}>加载场景</button>
        </div>
        <input ref={modelInput} aria-label="导入模型文件" type="file" multiple hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void editor.importFiles(files); }} />
        <input ref={folderInput} aria-label="导入模型目录" type="file" multiple hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void editor.importFiles(files); }} />
        <input ref={sceneInput} aria-label="加载场景文件" type="file" accept=".json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void editor.loadFile(file, onGroundLoaded); }} />
        <p className="scene-muted">glTF 请同时选择 .bin 与贴图；有子目录时请导入目录。支持未压缩模型，单次最多 100 MB。</p>
        <label className="scene-editor-check"><input type="checkbox" checked={editor.document.showBase} onChange={event => editor.updateDocument({ showBase: event.target.checked })} />显示默认试验场</label>
        <p className="scene-muted">保存为 .scene.json，包含模型、贴图、布局与参考地面海拔；加载后替换当前场景。离开视景前请保存。</p>
      </details>
      <details className="scene-editor-section"><summary>在线地景</summary>
        <label className="scene-editor-name">GLB/glTF 模型地址<input aria-label="在线地景地址" type="url" placeholder="https://example.com/airport.glb"
          value={onlineUrl} onChange={event => setOnlineUrl(event.target.value)} /></label>
        <label className="scene-editor-check"><input type="checkbox" checked={replaceScenery} onChange={event => setReplaceScenery(event.target.checked)} />替换当前地景，保留飞机和风袋</label>
        <div className="scene-editor-actions"><button className="scene-action" disabled={!onlineUrl.trim()} onClick={() => void editor.importOnline(onlineUrl, replaceScenery)}>在线加载地景</button></div>
        <p className="scene-muted">使用模型文件直链，自动读取配套贴图；服务器需允许跨域访问（CORS），合计最多 100 MB。加载完成后可保存场景供离线使用。Sketchfab 展示页不能直接替换飞行地景。</p>
      </details>
      <details className="scene-editor-section"><summary>仿真碰撞地图</summary>
        <p className="scene-muted">固定经纬度原点，1 单位 = 1 米。海拔使用仿真 WGS84 椭球高基准；地图必须使用同一基准。</p>
        {modelOrigin && <div className="scene-muted">
          {modelOrigin.loading ? <p>正在从 {model} 读取初始位置…</p>
            : modelOrigin.error ? <><p role="alert">{modelOrigin.error}</p><button className="scene-action" onClick={modelOrigin.refresh}>重新读取模型基准</button></>
            : modelOrigin.origin ? editor.document.georeference === modelOrigin.origin ? <p>已从 {model} 的初始状态自动获取地图基准；地面海拔来自 {modelOrigin.groundSource}。</p>
              : <><p>当前使用场景保存或手动设置的基准。</p><button className="scene-action" onClick={() => editor.applyModelOrigin(modelOrigin.origin, true)}>使用 {model} 的模型基准</button></>
            : <p>选择仿真模型后自动获取初始位置。</p>}
        </div>}
        {(['latitude', 'longitude', 'altitude'] as const).map((key, i) => <label key={key}>{['原点纬度 / °', '原点经度 / °', '基准海拔 / m'][i]}
          <NumberField label={['原点纬度', '原点经度', '基准海拔'][i]} value={editor.document.georeference?.[key]}
            digits={i < 2 ? 7 : 4} step={i < 2 ? .0000001 : .01} min={-[90, 180, 100000][i]} max={[90, 180, 100000][i]}
            onChange={value => editor.updateDocument({ georeference: { latitude: 0, longitude: 0, altitude: 0, ...editor.document.georeference, [key]: value } })} /></label>)}
        <label>飞机包络半径 / m<NumberField label="飞机包络半径" min={.01} value={editor.document.collisionRadius ?? .5} onChange={value => editor.updateDocument({ collisionRadius: value })} /></label>
        <label>视景地面高度偏移 / m<NumberField label="视景地面高度偏移" min={-MAX_VISUAL_GROUND_OFFSET_M} max={MAX_VISUAL_GROUND_OFFSET_M}
          step={.01} value={editor.document.visualGroundOffsetM ?? 0} onChange={value => editor.updateDocument({ visualGroundOffsetM: value })} /></label>
        <p className="scene-muted">正值抬高视景地面、缩短显示距离；负值降低地面。修改后自动保存在本机，下次打开自动恢复；仅调整画面，不改变仿真碰撞地图。</p>
        <p className="scene-muted">运行端：{sceneLoaded === 1 ? `已加载版本 ${sceneRevision ?? "未知"} · ${editor.collisionVersion !== null && editor.collisionVersion === sceneRevision ? "与本次导出一致" : "当前布局尚未核对"} · 接触 ${sceneContacts ?? "未知"}` : sceneLoaded === -1 ? "地图加载失败" : sceneLoaded === 0 ? "未加载碰撞地图" : "状态未知 / 数据过期"}</p>
        <button className="scene-action" disabled={!isTauri || !model} onClick={() => void editor.syncCollision(model)}>同步到 {model || "所选模型"}（读回校验）</button>
        <button className="scene-action" onClick={editor.exportCollision}>导出仿真碰撞地图</button>
        <p className="scene-muted">CG 球形包络，起落架保留原接地点；不是精确机体或损伤模型。导出不代表已加载。物体编辑后必须重新导出并加载。远景背景、阴影与网格辅助线不参与碰撞。</p>
      </details>
      <details className="scene-editor-section" open><summary>场景物体 · {editor.document.objects.length}</summary>
        <p className="scene-muted">风袋 {editor.document.objects.filter(object => object.builtin === 'windsock').length} 个。可连续添加或复制，选中后拖动三轴手柄或输入位置。风袋独立于默认试验场显示。</p>
        <div className="scene-object-list" ref={list}>{editor.document.objects.map(object => <button className={`scene-object-row ${object.id === editor.selectedId ? 'selected' : ''}`} key={object.id}
          aria-pressed={object.id === editor.selectedId} data-scene-object={object.id} data-scene-source={object.builtin ? 'builtin' : 'model'} onClick={() => editor.setSelectedId(object.id)} onDoubleClick={editor.focus}>
          <span>{sceneObjectVisible(object, editor.document.showBase) ? '◇' : '◌'}</span><span>{object.name}</span>
        </button>)}</div>
        <p className="scene-muted">跑道、机库、停机坪、F-35、风袋和每棵树都可单独选择；也可导入外部模型。</p>
      </details>

    </fieldset>
  </aside>;
}
