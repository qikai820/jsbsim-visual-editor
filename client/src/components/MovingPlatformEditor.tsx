import type { AircraftNode } from '../types';
import { movingPlatformParameters as parameters } from '../utils/movingPlatformConfig';
import FloatInput from './FloatInput';
export default function MovingPlatformEditor({node,onChange,onRemove}:{node:AircraftNode;onChange:(p:Record<string,any>)=>void;onRemove:()=>void}) {
  const p=node.data.params;
  const choices:Record<string,string[]>={
    'moving-platform/enabled':['关闭','启用'],
    'moving-platform/ship-collision':['关闭（仅原接触模型）','船体碰撞与甲板降落'],
    'moving-platform/contact-mode':['移动甲板','双杆导向','甲板与双杆'],
    'scenario/mode':['静止','3 m/s 行进','3 m/s 轻晃','5 m/s 强晃','左杆卡滞','右杆卡滞','自定义'],
  };
  return <div className="property-panel" data-testid="moving-platform-editor">
    <h3>移动平台起降</h3>
    <p style={{fontSize:12}}>用于车船平台的甲板起降与双杆导向起飞。修改后保存并重新加载模型。</p>
    <label>名称 <input value={p.name || '移动平台起降'} onChange={e=>onChange({name:e.target.value})}/></label>
    <p style={{fontSize:12}}>开启船体网格后，船舷、驾驶舱和甲板随平台运动参与碰撞；飞机使用原起落架在甲板降落。需要支持 moving_platform_mesh 的仿真固件。</p>
    {[...new Set(parameters.map(x=>x.group))].map(group=><details key={group} open={group==='场景'}>
      <summary style={{padding:'10px 0',cursor:'pointer'}}>{group}</summary>
      {parameters.filter(x=>x.group===group).map(def=><div className="field-row" key={def.path}>
        <label title={def.path}>{def.label} {def.unit}</label>
        {choices[def.path] ? <select aria-label={def.label} value={Number(p[def.path] ?? def.default)} onChange={e=>onChange({[def.path]:Number(e.target.value)})}>{choices[def.path].map((label,index)=><option key={index} value={index}>{label}</option>)}</select> : <FloatInput aria-label={def.label} value={Number(p[def.path] ?? def.default)} onValueChange={value=>onChange({[def.path]:value})}/>}
      </div>)}
    </details>)}
    <p style={{fontSize:12}}>坐标为北东地和前右下，几何单位为米。机体包络用于船舷和驾驶舱避穿透，甲板支撑与摩擦使用原起落架参数；关闭网格时使用原四点甲板接触。双杆离杆后不自动回收接合。杆间距、间隙和接触系数需按实物标定。</p>
    <button className="delete-btn" onClick={onRemove}>删除部件</button>
  </div>;
}
