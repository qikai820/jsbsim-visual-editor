import type { ComponentDef } from '../types';
export const movingPlatformParameters = [
  {
    "id": "ShipCollision", "path": "moving-platform/ship-collision", "label": "船体网格与甲板降落",
    "default": 1, "group": "场景", "unit": "", "min": 0, "max": 1
  },
  {
    "id": "CollisionRadius", "path": "moving-platform/collision-radius-m", "label": "机体碰撞包络半径",
    "default": 0.2, "group": "甲板", "unit": "m", "min": 0.01, "max": 100
  },
  {
    "id": "Enabled",
    "path": "moving-platform/enabled",
    "label": "启用",
    "default": 1,
    "group": "场景",
    "unit": "",
    "min": 0,
    "max": 1
  },
  {
    "id": "ContactMode",
    "path": "moving-platform/contact-mode",
    "label": "接触方式",
    "default": 1,
    "group": "场景",
    "unit": "",
    "min": 0,
    "max": 2
  },
  {
    "id": "Scenario",
    "path": "scenario/mode",
    "label": "场景",
    "default": 0,
    "group": "场景",
    "unit": "",
    "min": 0,
    "max": 6
  },
  {
    "id": "SpeedN",
    "path": "scenario/custom/speed-n-mps",
    "label": "北向速度",
    "default": 3,
    "group": "自定义运动",
    "unit": "m/s",
    "min": null,
    "max": null
  },
  {
    "id": "SpeedE",
    "path": "scenario/custom/speed-e-mps",
    "label": "东向速度",
    "default": 0,
    "group": "自定义运动",
    "unit": "m/s",
    "min": null,
    "max": null
  },
  {
    "id": "Roll",
    "path": "scenario/custom/roll-deg",
    "label": "横摇幅度",
    "default": 1.71887338539247,
    "group": "自定义运动",
    "unit": "deg",
    "min": null,
    "max": null
  },
  {
    "id": "Pitch",
    "path": "scenario/custom/pitch-deg",
    "label": "纵摇幅度",
    "default": 1.145915590261646,
    "group": "自定义运动",
    "unit": "deg",
    "min": null,
    "max": null
  },
  {
    "id": "Heave",
    "path": "scenario/custom/heave-m",
    "label": "升沉幅度",
    "default": 0.03,
    "group": "自定义运动",
    "unit": "m",
    "min": null,
    "max": null
  },
  {
    "id": "YawRate",
    "path": "scenario/custom/yaw-rate-degps",
    "label": "偏航角速度",
    "default": 0,
    "group": "自定义运动",
    "unit": "deg/s",
    "min": null,
    "max": null
  },
  {
    "id": "JamL",
    "path": "scenario/custom/jam-left",
    "label": "左杆卡滞",
    "default": 0,
    "group": "自定义运动",
    "unit": "",
    "min": 0,
    "max": 1
  },
  {
    "id": "JamR",
    "path": "scenario/custom/jam-right",
    "label": "右杆卡滞",
    "default": 0,
    "group": "自定义运动",
    "unit": "",
    "min": 0,
    "max": 1
  },
  {
    "id": "Ramp",
    "path": "moving-platform/speed-ramp-s",
    "label": "速度渐入时间",
    "default": 2,
    "group": "自定义运动",
    "unit": "s",
    "min": 0.01,
    "max": null
  },
  {
    "id": "RollPeriod",
    "path": "moving-platform/roll-period-s",
    "label": "横摇周期",
    "default": 4,
    "group": "自定义运动",
    "unit": "s",
    "min": 0.5,
    "max": null
  },
  {
    "id": "PitchPeriod",
    "path": "moving-platform/pitch-period-s",
    "label": "纵摇周期",
    "default": 4,
    "group": "自定义运动",
    "unit": "s",
    "min": 0.5,
    "max": null
  },
  {
    "id": "HeavePeriod",
    "path": "moving-platform/heave-period-s",
    "label": "升沉周期",
    "default": 4,
    "group": "自定义运动",
    "unit": "s",
    "min": 0.5,
    "max": null
  },
  {
    "id": "RollPhase",
    "path": "moving-platform/roll-phase-deg",
    "label": "横摇相位",
    "default": 0,
    "group": "自定义运动",
    "unit": "deg",
    "min": null,
    "max": null
  },
  {
    "id": "PitchPhase",
    "path": "moving-platform/pitch-phase-deg",
    "label": "纵摇相位",
    "default": 0,
    "group": "自定义运动",
    "unit": "deg",
    "min": null,
    "max": null
  },
  {
    "id": "HeavePhase",
    "path": "moving-platform/heave-phase-deg",
    "label": "升沉相位",
    "default": 0,
    "group": "自定义运动",
    "unit": "deg",
    "min": null,
    "max": null
  },
  {
    "id": "AccelN",
    "path": "moving-platform/acceleration-n-mps2",
    "label": "北向加速度",
    "default": 0,
    "group": "自定义运动",
    "unit": "m/s²",
    "min": null,
    "max": null
  },
  {
    "id": "AccelE",
    "path": "moving-platform/acceleration-e-mps2",
    "label": "东向加速度",
    "default": 0,
    "group": "自定义运动",
    "unit": "m/s²",
    "min": null,
    "max": null
  },
  {
    "id": "OffsetN",
    "path": "moving-platform/origin-n-m",
    "label": "平台北向偏移",
    "default": 0,
    "group": "自定义运动",
    "unit": "m",
    "min": null,
    "max": null
  },
  {
    "id": "OffsetE",
    "path": "moving-platform/origin-e-m",
    "label": "平台东向偏移",
    "default": 0,
    "group": "自定义运动",
    "unit": "m",
    "min": null,
    "max": null
  },
  {
    "id": "OffsetD",
    "path": "moving-platform/origin-d-m",
    "label": "平台向下偏移",
    "default": 0,
    "group": "自定义运动",
    "unit": "m",
    "min": null,
    "max": null
  },
  {
    "id": "Length",
    "path": "guide-rail/length-m",
    "label": "杆长",
    "default": 1.5,
    "group": "双杆",
    "unit": "m",
    "min": 0.01,
    "max": null
  },
  {
    "id": "Spacing",
    "path": "guide-rail/spacing-m",
    "label": "杆间距",
    "default": 0.36,
    "group": "双杆",
    "unit": "m",
    "min": 0.01,
    "max": null
  },
  {
    "id": "Sleeve",
    "path": "guide-rail/sleeve-m",
    "label": "套筒长度",
    "default": 0.1,
    "group": "双杆",
    "unit": "m",
    "min": 0.001,
    "max": null
  },
  {
    "id": "Clearance",
    "path": "guide-rail/clearance-m",
    "label": "径向间隙",
    "default": 0.001,
    "group": "双杆",
    "unit": "m",
    "min": 0,
    "max": null
  },
  {
    "id": "LateralK",
    "path": "guide-rail/lateral-k",
    "label": "侧向刚度",
    "default": 10000,
    "group": "双杆",
    "unit": "N/m",
    "min": 1,
    "max": null
  },
  {
    "id": "LateralC",
    "path": "guide-rail/lateral-c",
    "label": "侧向阻尼",
    "default": 150,
    "group": "双杆",
    "unit": "N·s/m",
    "min": 0,
    "max": null
  },
  {
    "id": "AxialK",
    "path": "guide-rail/axial-k",
    "label": "底部/卡滞刚度",
    "default": 40000,
    "group": "双杆",
    "unit": "N/m",
    "min": 1,
    "max": null
  },
  {
    "id": "AxialC",
    "path": "guide-rail/axial-c",
    "label": "轴向阻尼",
    "default": 500,
    "group": "双杆",
    "unit": "N·s/m",
    "min": 0,
    "max": null
  },
  {
    "id": "RailMu",
    "path": "guide-rail/friction",
    "label": "杆摩擦系数",
    "default": 0.05,
    "group": "双杆",
    "unit": "",
    "min": 0,
    "max": null
  },
  {
    "id": "CgZ",
    "path": "guide-rail/cg-z-m",
    "label": "套筒中心相对重心向上距离",
    "default": 0,
    "group": "双杆",
    "unit": "m",
    "min": null,
    "max": null
  },
  {
    "id": "Invalid",
    "path": "guide-rail/invalid-mask",
    "label": "杆传感器失效掩码 0到3",
    "default": 0,
    "group": "双杆",
    "unit": "",
    "min": 0,
    "max": 3
  },
  {
    "id": "DeckLength",
    "path": "moving-platform/deck-length-m",
    "label": "甲板长度",
    "default": 4,
    "group": "甲板",
    "unit": "m",
    "min": 0.01,
    "max": null
  },
  {
    "id": "DeckWidth",
    "path": "moving-platform/deck-width-m",
    "label": "甲板宽度",
    "default": 3,
    "group": "甲板",
    "unit": "m",
    "min": 0.01,
    "max": null
  },
  {
    "id": "DeckZ",
    "path": "moving-platform/deck-z-m",
    "label": "甲板平面向下偏移",
    "default": 0.25,
    "group": "甲板",
    "unit": "m",
    "min": null,
    "max": null
  },
  {
    "id": "FootX",
    "path": "moving-platform/foot-half-x-m",
    "label": "起落架前后半间距",
    "default": 0.18,
    "group": "甲板",
    "unit": "m",
    "min": 0.001,
    "max": null
  },
  {
    "id": "FootY",
    "path": "moving-platform/foot-half-y-m",
    "label": "起落架左右半间距",
    "default": 0.18,
    "group": "甲板",
    "unit": "m",
    "min": 0.001,
    "max": null
  },
  {
    "id": "FootZ",
    "path": "moving-platform/foot-z-m",
    "label": "接触点相对重心向下距离",
    "default": 0.25,
    "group": "甲板",
    "unit": "m",
    "min": null,
    "max": null
  },
  {
    "id": "DeckK",
    "path": "moving-platform/deck-k",
    "label": "单接触点刚度",
    "default": 20000,
    "group": "甲板",
    "unit": "N/m",
    "min": 1,
    "max": null
  },
  {
    "id": "DeckC",
    "path": "moving-platform/deck-c",
    "label": "单接触点阻尼",
    "default": 600,
    "group": "甲板",
    "unit": "N·s/m",
    "min": 0,
    "max": null
  },
  {
    "id": "StaticMu",
    "path": "moving-platform/static-friction",
    "label": "静摩擦上限",
    "default": 0.7,
    "group": "甲板",
    "unit": "",
    "min": 0,
    "max": null
  },
  {
    "id": "DynamicMu",
    "path": "moving-platform/dynamic-friction",
    "label": "动摩擦系数",
    "default": 0.5,
    "group": "甲板",
    "unit": "",
    "min": 0,
    "max": null
  },
  {
    "id": "Slip",
    "path": "moving-platform/slip-speed-mps",
    "label": "摩擦正则速度",
    "default": 0.02,
    "group": "甲板",
    "unit": "m/s",
    "min": 0.001,
    "max": null
  },
  {
    "id": "Delay",
    "path": "moving-platform/sensor-delay-s",
    "label": "双杆传感延迟",
    "default": 0,
    "group": "传感器",
    "unit": "s",
    "min": 0,
    "max": 2
  },
  {
    "id": "Noise",
    "path": "moving-platform/sensor-noise-m",
    "label": "行程均匀噪声幅值",
    "default": 0,
    "group": "传感器",
    "unit": "m",
    "min": 0,
    "max": 0.1
  },
  {
    "id": "InitialAgl",
    "path": "moving-platform/initial-cg-agl-m",
    "label": "起始重心离地高度",
    "default": 2.27,
    "group": "场景",
    "unit": "m",
    "min": 0.25,
    "max": 100
  },
  {
    "id": "FixedPitch",
    "path": "moving-platform/fixed-pitch-deg",
    "label": "固定 Pitch",
    "default": 0,
    "group": "场景",
    "unit": "°",
    "min": null,
    "max": null
  },
  {
    "id": "FixedRoll",
    "path": "moving-platform/fixed-roll-deg",
    "label": "固定 Roll",
    "default": 0,
    "group": "场景",
    "unit": "°",
    "min": null,
    "max": null
  }
] as const;
export const movingPlatformDefinition: ComponentDef = {type:'moving_platform',label:'移动平台起降',category:'实验环境',color:'#167f8b',icon:'⚓',description:'C++ 移动甲板与双杆接触。车船运动、起飞和甲板降落；保存并重新加载生效。',params:{name:{label:'名称',type:'string',default:'移动平台起降'},...Object.fromEntries(movingPlatformParameters.map(p=>[p.path,{label:p.label,type:'number',default:p.default,unit:p.unit}]))},inputs:[],outputs:[{id:'external',label:'接触力与力矩'}]};
