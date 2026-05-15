/**
 * 機体形状テンプレート (Python glider_templates.py の WebUI 移植)
 *
 * 座標系:
 *   +X = 右翼方向
 *   +Y = 上方向
 *   +Z = 機首方向
 *
 * Python 側は実機センチ感覚の数値 (wing_span=50 等) を使っているが、
 * R3F のシーンスケール (機体長 ~3 単位) に合わせて 0.1 倍で取り込む。
 */

export type WingSpec = {
  span: number;
  chordRoot: number;
  chordTip: number;
  sweepDeg: number;
  dihedralDeg: number;
  posZ: number;
  posY: number;
  color: string;
};

export type TailSpec = {
  span: number;
  chord: number;
  sweepDeg: number;
  posZ: number;
  posY: number;
  color: string;
};

export type VTailSpec = {
  height: number;
  chord: number;
  posZ: number;
  posY: number;
  color: string;
};

export type PlaneSpec = {
  name: string;
  label: string;
  description: string;
  fuselage: { length: number; width: number; height: number; color: string };
  nose: { length: number; radius: number; color: string } | null;
  wing: WingSpec | null;
  wing2: { offsetY: number; offsetZ: number } | null; // 複葉機の2枚目（メイン翼と同形状でオフセット）
  htail: TailSpec | null;
  vtail: VTailSpec | null;
  canard: TailSpec | null;
};

// Python の数値を R3F のスケールに変換するヘルパー (= ×0.1)
const S = 0.1;

export const PRESETS: Record<string, PlaneSpec> = {
  // ---- 1. 標準ビギナーグライダー ----
  default: {
    name: "default",
    label: "Default Glider",
    description: "標準ビギナーグライダー（上反角 5°）",
    fuselage: { length: 30 * S, width: 2.5 * S, height: 2.5 * S, color: "#d9d9e6" },
    nose: { length: 6 * S, radius: 1.5 * S, color: "#f0f0f8" },
    wing: {
      span: 50 * S, chordRoot: 10 * S, chordTip: 10 * S,
      sweepDeg: 0, dihedralDeg: 5,
      posZ: 0, posY: 1 * S,
      color: "#ffd93b",
    },
    wing2: null,
    htail: { span: 15 * S, chord: 4 * S, sweepDeg: 0, posZ: -14 * S, posY: 0.5 * S, color: "#ff922b" },
    vtail: { height: 5 * S, chord: 4 * S, posZ: -14 * S, posY: 1.5 * S, color: "#e03131" },
    canard: null,
  },

  // ---- 2. 高アスペクト比 (競技グライダー) ----
  high_ar: {
    name: "high_ar",
    label: "High Aspect Ratio",
    description: "高アスペクト比・テーパー強め（競技用グライダー風）",
    fuselage: { length: 35 * S, width: 2.5 * S, height: 2.5 * S, color: "#d9d9e6" },
    nose: { length: 6 * S, radius: 1.5 * S, color: "#f0f0f8" },
    wing: {
      span: 80 * S, chordRoot: 6 * S, chordTip: 3 * S,
      sweepDeg: 0, dihedralDeg: 3,
      posZ: 0, posY: 1 * S,
      color: "#66b4ff",
    },
    wing2: null,
    htail: { span: 12 * S, chord: 3 * S, sweepDeg: 0, posZ: -14 * S, posY: 0.5 * S, color: "#ff922b" },
    vtail: { height: 5 * S, chord: 4 * S, posZ: -14 * S, posY: 1.5 * S, color: "#e03131" },
    canard: null,
  },

  // ---- 3. 後退翼 (高速機) ----
  swept: {
    name: "swept",
    label: "Swept Wing",
    description: "強い後退角・尖った機首（高速機風）",
    fuselage: { length: 30 * S, width: 2.5 * S, height: 2.5 * S, color: "#d9d9e6" },
    nose: { length: 8 * S, radius: 1.5 * S, color: "#f0f0f8" },
    wing: {
      span: 45 * S, chordRoot: 10 * S, chordTip: 4 * S,
      sweepDeg: 25, dihedralDeg: 2,
      posZ: 0, posY: 1 * S,
      color: "#b3b3e6",
    },
    wing2: null,
    htail: { span: 12 * S, chord: 4 * S, sweepDeg: 20, posZ: -14 * S, posY: 0.5 * S, color: "#ff922b" },
    vtail: { height: 5 * S, chord: 4 * S, posZ: -14 * S, posY: 1.5 * S, color: "#e03131" },
    canard: null,
  },

  // ---- 4. デルタ翼 ----
  delta: {
    name: "delta",
    label: "Delta Wing",
    description: "三角翼・水平尾翼なし",
    fuselage: { length: 24 * S, width: 2.5 * S, height: 2.5 * S, color: "#d9d9e6" },
    nose: { length: 10 * S, radius: 1.5 * S, color: "#f0f0f8" },
    wing: {
      span: 40 * S, chordRoot: 20 * S, chordTip: 2 * S,
      sweepDeg: 45, dihedralDeg: 0,
      posZ: 0, posY: 1 * S,
      color: "#e64d4d",
    },
    wing2: null,
    htail: null,
    vtail: { height: 5 * S, chord: 4 * S, posZ: -12 * S, posY: 1.5 * S, color: "#e03131" },
    canard: null,
  },

  // ---- 5. カナード機 ----
  canard: {
    name: "canard",
    label: "Canard",
    description: "前翼 (カナード) 付き、水平尾翼なし",
    fuselage: { length: 30 * S, width: 2.5 * S, height: 2.5 * S, color: "#d9d9e6" },
    nose: { length: 6 * S, radius: 1.5 * S, color: "#f0f0f8" },
    wing: {
      span: 45 * S, chordRoot: 8 * S, chordTip: 5 * S,
      sweepDeg: 10, dihedralDeg: 0,
      posZ: -3 * S, posY: 1 * S,
      color: "#ffb300",
    },
    wing2: null,
    htail: null,
    vtail: { height: 5 * S, chord: 4 * S, posZ: -14 * S, posY: 1.5 * S, color: "#e03131" },
    canard: { span: 18 * S, chord: 4 * S, sweepDeg: 0, posZ: 14 * S, posY: 1 * S, color: "#66ff66" },
  },

  // ---- 6. 全翼機 (フライング・ウィング) ----
  flying_wing: {
    name: "flying_wing",
    label: "Flying Wing",
    description: "胴体・尾翼を持たない全翼機",
    fuselage: { length: 10 * S, width: 4 * S, height: 2 * S, color: "#d9d9e6" },
    nose: { length: 2 * S, radius: 2 * S, color: "#f0f0f8" },
    wing: {
      span: 60 * S, chordRoot: 18 * S, chordTip: 4 * S,
      sweepDeg: 30, dihedralDeg: 2,
      posZ: 0, posY: 0,
      color: "#9966cc",
    },
    wing2: null,
    htail: null,
    vtail: null,
    canard: null,
  },

  // ---- 7. 複葉機 ----
  biplane: {
    name: "biplane",
    label: "Biplane",
    description: "上下に2枚の主翼を持つ複葉機",
    fuselage: { length: 28 * S, width: 3 * S, height: 4 * S, color: "#d9d9e6" },
    nose: { length: 6 * S, radius: 1.5 * S, color: "#f0f0f8" },
    wing: {
      span: 45 * S, chordRoot: 8 * S, chordTip: 8 * S,
      sweepDeg: 0, dihedralDeg: 0,
      posZ: 0, posY: 2 * S,
      color: "#f2b34d",
    },
    wing2: { offsetY: -7 * S, offsetZ: 2 * S },
    htail: { span: 15 * S, chord: 4 * S, sweepDeg: 0, posZ: -14 * S, posY: 0.5 * S, color: "#ff922b" },
    vtail: { height: 5 * S, chord: 4 * S, posZ: -14 * S, posY: 1.5 * S, color: "#e03131" },
    canard: null,
  },

  // ---- 8. 上反角強め (V字翼) ----
  high_dihedral: {
    name: "high_dihedral",
    label: "High Dihedral",
    description: "強い上反角の V 字翼（高安定）",
    fuselage: { length: 30 * S, width: 2.5 * S, height: 2.5 * S, color: "#d9d9e6" },
    nose: { length: 6 * S, radius: 1.5 * S, color: "#f0f0f8" },
    wing: {
      span: 50 * S, chordRoot: 8 * S, chordTip: 8 * S,
      sweepDeg: 0, dihedralDeg: 15,
      posZ: 0, posY: 1 * S,
      color: "#80e680",
    },
    wing2: null,
    htail: { span: 15 * S, chord: 4 * S, sweepDeg: 0, posZ: -14 * S, posY: 0.5 * S, color: "#ff922b" },
    vtail: { height: 5 * S, chord: 4 * S, posZ: -14 * S, posY: 1.5 * S, color: "#e03131" },
    canard: null,
  },
};

export const PRESET_ORDER = [
  "default",
  "high_ar",
  "swept",
  "delta",
  "canard",
  "flying_wing",
  "biplane",
  "high_dihedral",
] as const;

export type PresetKey = (typeof PRESET_ORDER)[number];

export function getPreset(name: string): PlaneSpec {
  return PRESETS[name] ?? PRESETS.default;
}
