// =============================================================
//  autotune_sim.mjs — Full Auto Tune の数値シミュレーション検証
//
//  目的: ハードウェア無しで useAutoTune.ts の中核ロジックが「正しく動くか」を確認する。
//
//  構成:
//    1) Plant       … 風洞固定の機体回転動特性 (2次系 + 伝達遅れ + 30Hz ZOH)
//    2) 真の Ku/Tu  … 同じ Plant を細かい Kp グリッドで総当りし、発振境界を独立に求める
//    3) AutoTuner   … useAutoTune.ts から analyzeResponse / zieglerNichols / スイープ判定を
//                     “そのまま移植” して実行し、Ku/Tu を検出させる
//    4) 比較        … 検出 Ku/Tu が真値に近いか / 算出 PID が実際に安定するか
//    5) 例外系       … 「発振せず=failed」「安全中断=aborted」分岐の妥当性
//
//  ※ ファーム PID は GYRO-D 既定 (de=-omega) を含めて再現。30Hz・±90 飽和・I 制限も同じ。
// =============================================================

const FREQ = 30; // 制御ループ [Hz] (firmware MEASURING_FREQ)
const CTRL_DT = 1 / FREQ; // 制御周期 [s] = 33.3ms
const SUBSTEP = 0.001; // 連続系の積分刻み [s]
const SAT = 90; // PID 出力飽和 [deg] (firmware OUTPUT_SAT)
const I_LIMIT = 50; // I 項制限 (firmware integralLimit)

// ---------- Plant: I*θ'' = -c θ' - k θ + b·u(t-τ) ----------
//   2次系の標準形:  θ'' + 2ζωn θ' + ωn² θ = K·ωn²·u_delayed
//   θ: 機体角[deg], u: 舵角指令[deg], 伝達遅れ τ (サーボ+フィルタ群遅延+ZOH を代表)
class Plant {
  constructor({ wn, zeta, K, delaySec }) {
    this.wn = wn;
    this.zeta = zeta;
    this.K = K;
    this.theta = 0;
    this.omega = 0;
    this.delaySteps = Math.max(0, Math.round(delaySec / SUBSTEP));
    this.buf = new Array(this.delaySteps).fill(0);
    this.ptr = 0;
  }
  reset(theta0 = 0, omega0 = 0) {
    this.theta = theta0;
    this.omega = omega0;
    this.buf.fill(0);
    this.ptr = 0;
  }
  _deriv(s, u) {
    const dtheta = s[1];
    const domega =
      -2 * this.zeta * this.wn * s[1] - this.wn * this.wn * s[0] + this.K * this.wn * this.wn * u;
    return [dtheta, domega];
  }
  // 1 制御周期 (CTRL_DT) を ZOH の u_cmd で前進。内部は SUBSTEP で RK4。
  stepControlPeriod(u_cmd) {
    const n = Math.round(CTRL_DT / SUBSTEP);
    for (let i = 0; i < n; i++) {
      // 伝達遅れ適用
      let u = u_cmd;
      if (this.delaySteps > 0) {
        u = this.buf[this.ptr];
        this.buf[this.ptr] = u_cmd;
        this.ptr = (this.ptr + 1) % this.delaySteps;
      }
      // RK4
      const s = [this.theta, this.omega];
      const k1 = this._deriv(s, u);
      const k2 = this._deriv([s[0] + 0.5 * SUBSTEP * k1[0], s[1] + 0.5 * SUBSTEP * k1[1]], u);
      const k3 = this._deriv([s[0] + 0.5 * SUBSTEP * k2[0], s[1] + 0.5 * SUBSTEP * k2[1]], u);
      const k4 = this._deriv([s[0] + SUBSTEP * k3[0], s[1] + SUBSTEP * k3[1]], u);
      this.theta += (SUBSTEP / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      this.omega += (SUBSTEP / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    }
  }
}

const clampf = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ============================================================
//  ★ useAutoTune.ts から “そのまま移植” したコア (verbatim port)
// ============================================================
function zieglerNichols(Ku, Tu, rule) {
  let Kp = 0, Ti = Infinity, Td = 0;
  switch (rule) {
    case "classic": Kp = 0.6 * Ku; Ti = 0.5 * Tu; Td = 0.125 * Tu; break;
    case "pessen": Kp = 0.7 * Ku; Ti = 0.4 * Tu; Td = 0.15 * Tu; break;
    case "some-overshoot": Kp = 0.33 * Ku; Ti = 0.5 * Tu; Td = 0.33 * Tu; break;
    case "no-overshoot": Kp = 0.2 * Ku; Ti = 0.5 * Tu; Td = 0.33 * Tu; break;
  }
  const Ki = Ti > 0 && Number.isFinite(Ti) ? Kp / Ti : 0;
  const Kd = Kp * Td;
  return { Kp, Ki, Kd };
}

function analyzeResponse(samples, baseline, noiseDeg) {
  if (samples.length < 8) return { p2p: 0, periodSec: 0, decay: 0, nPeaks: 0 };
  const dev = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)].v;
    const b = samples[i].v;
    const c = samples[Math.min(samples.length - 1, i + 1)].v;
    dev[i] = (a + b + c) / 3 - baseline;
  }
  let maxV = -Infinity, minV = Infinity;
  for (const d of dev) { if (d > maxV) maxV = d; if (d < minV) minV = d; }
  const p2p = maxV - minV;
  const crossT = [];
  let prevSign = 0;
  for (let i = 0; i < dev.length; i++) {
    if (Math.abs(dev[i]) < noiseDeg) continue;
    const s = dev[i] > 0 ? 1 : -1;
    if (prevSign !== 0 && s !== prevSign) {
      const t0 = samples[Math.max(0, i - 1)].t;
      const t1 = samples[i].t;
      crossT.push((t0 + t1) / 2);
    }
    prevSign = s;
  }
  let periodSec = 0;
  if (crossT.length >= 2) {
    let sum = 0;
    for (let i = 1; i < crossT.length; i++) sum += crossT[i] - crossT[i - 1];
    const halfPeriodMs = sum / (crossT.length - 1);
    periodSec = (2 * halfPeriodMs) / 1000;
  }
  const peakMags = [];
  for (let i = 1; i < dev.length - 1; i++) {
    const a = Math.abs(dev[i - 1]);
    const b = Math.abs(dev[i]);
    const c = Math.abs(dev[i + 1]);
    if (b >= a && b >= c && b > noiseDeg) { peakMags.push(b); i++; }
  }
  let decay = 0;
  if (peakMags.length >= 2) {
    const ratios = [];
    for (let i = 1; i < peakMags.length; i++) {
      if (peakMags[i - 1] > 1e-6) ratios.push(peakMags[i] / peakMags[i - 1]);
    }
    if (ratios.length) {
      ratios.sort((x, y) => x - y);
      decay = ratios[Math.floor(ratios.length / 2)];
    }
  }
  return { p2p, periodSec, decay, nPeaks: peakMags.length };
}

const DEFAULT_CONFIG = {
  rule: "classic", kpStart: 0.5, kpStep: 0.3, kpMax: 8.0,
  kickDeg: 8.0, kickMs: 160, settleMs: 900, recordMs: 3600,
  safeAngleDeg: 40.0, oscThreshDeg: 3.0, sustainRatio: 0.9,
};

// ============================================================
//  シミュ用ヘルパ: P 単独で duration[ms] 走らせ 30Hz サンプルを返す
//    (firmware: wt + Ki=Kd=0 → u = clamp(Kp*(target-θ), ±90))
//    plant 状態は呼び出し間で継続 (実機の物理連続性を再現)
// ============================================================
function runPhase(plant, kp, target, durationMs, tStartMs, safeBaseline, safeAngle) {
  const samples = [];
  const nTicks = Math.round(durationMs / 1000 / CTRL_DT);
  let t = tStartMs;
  let aborted = false;
  for (let i = 0; i < nTicks; i++) {
    const theta = plant.theta;
    // 安全判定 (record 中のみ baseline 偏差で評価)
    if (safeBaseline != null) {
      if (Math.abs(theta - safeBaseline) > safeAngle) { aborted = true; break; }
    }
    const u = clampf(kp * (target - theta), -SAT, SAT);
    plant.stepControlPeriod(u);
    t += CTRL_DT * 1000;
    samples.push({ t, v: plant.theta });
  }
  return { samples, tEnd: t, aborted };
}

// ============================================================
//  AutoTuner: useAutoTune.run() のスイープ判定を移植
// ============================================================
function autoTune(plant, cfg, { verbose = false } = {}) {
  plant.reset(0, 0);
  let t = 0;
  const sweep = [];
  let Ku = null, Tu = 0;
  for (let kp = cfg.kpStart; kp <= cfg.kpMax + 1e-9; kp += cfg.kpStep) {
    const kpR = Math.round(kp * 1000) / 1000;
    // 整定 + baseline
    const settle = runPhase(plant, kpR, 0, cfg.settleMs, t, null, 0);
    t = settle.tEnd;
    const tail = settle.samples.slice(-10);
    const baseline = tail.length ? tail.reduce((s, x) => s + x.v, 0) / tail.length : 0;
    // キック
    const kick = runPhase(plant, kpR, cfg.kickDeg, cfg.kickMs, t, null, 0);
    t = kick.tEnd;
    // 応答録り (安全監視つき)
    const rec = runPhase(plant, kpR, 0, cfg.recordMs, t, baseline, cfg.safeAngleDeg);
    t = rec.tEnd;
    const noise = Math.max(0.8, cfg.oscThreshDeg * 0.25);
    const m = analyzeResponse(rec.samples, baseline, noise);
    const sustained =
      m.p2p >= cfg.oscThreshDeg && m.periodSec > 0.05 && m.nPeaks >= 2 && m.decay >= cfg.sustainRatio;
    sweep.push({ kp: kpR, ...m, aborted: rec.aborted, sustained });
    if (verbose) {
      console.log(
        `  Kp=${kpR.toFixed(2)}  p2p=${m.p2p.toFixed(1).padStart(5)}°  ` +
        `Tu=${m.periodSec.toFixed(3)}s  decay=${m.decay.toFixed(2)}  ` +
        `peaks=${m.nPeaks}  ${rec.aborted ? "⚠ABORT" : sustained ? "★SUSTAINED" : "damped"}`,
      );
    }
    if (rec.aborted) return { result: "aborted", sweep, atKp: kpR };
    if (sustained) { Ku = kpR; Tu = m.periodSec; break; }
  }
  if (Ku == null) return { result: "failed", sweep };
  const g = zieglerNichols(Ku, Tu, cfg.rule);
  return { result: "done", sweep, Ku, Tu, gains: g };
}

// ============================================================
//  独立検証: 真の Ku/Tu (細グリッド総当りの発振境界)
//    小さな初期擾乱から P 単独応答を録り、ピーク振幅比≈1 の Kp を Ku とみなす
// ============================================================
function trueUltimate(plantParams) {
  const p = new Plant(plantParams);
  let prevRatio = null, Ku = null, Tu = 0;
  for (let kp = 0.2; kp <= 8; kp += 0.05) {
    p.reset(3, 0); // 3°の初期擾乱
    const { samples } = runPhase(p, kp, 0, 7000, 0, null, 0);
    // ピーク (|θ| 局所極大) 列
    const peaks = [];
    for (let i = 1; i < samples.length - 1; i++) {
      const a = Math.abs(samples[i - 1].v), b = Math.abs(samples[i].v), c = Math.abs(samples[i + 1].v);
      if (b >= a && b >= c && b > 0.05) { peaks.push(b); i++; }
    }
    if (peaks.length < 3) continue;
    const ratios = [];
    for (let i = 1; i < peaks.length; i++) if (peaks[i - 1] > 1e-6) ratios.push(peaks[i] / peaks[i - 1]);
    ratios.sort((x, y) => x - y);
    const ratio = ratios[Math.floor(ratios.length / 2)];
    if (prevRatio != null && prevRatio < 1 && ratio >= 1) {
      // 線形補間で境界 Kp
      const frac = (1 - prevRatio) / (ratio - prevRatio);
      Ku = kp - 0.05 + 0.05 * frac;
      // Tu: この Kp でのゼロ交差周期
      const m = analyzeResponse(samples.map((s) => ({ t: s.t, v: s.v })), 0, 0.3);
      Tu = m.periodSec;
      break;
    }
    prevRatio = ratio;
  }
  return { Ku, Tu };
}

// ============================================================
//  仕上げ確認: 算出 PID (full PID, GYRO-D) で目標ステップ応答
//    firmware 同等: u = Kp*e + Ki*∫e + Kd*(-ω),  ±90 飽和, I 制限+anti-windup
// ============================================================
function stepResponse(plantParams, gains, stepDeg = 10, durMs = 6000) {
  const p = new Plant(plantParams);
  p.reset(0, 0);
  const { Kp, Ki, Kd } = gains;
  let integ = 0;
  const nTicks = Math.round(durMs / 1000 / CTRL_DT);
  const ys = [];
  for (let i = 0; i < nTicks; i++) {
    const theta = p.theta, omega = p.omega;
    const e = stepDeg - theta;
    integ += e * CTRL_DT;
    integ = clampf(integ, -I_LIMIT, I_LIMIT);
    const de = -omega; // GYRO-D
    let u = Kp * e + Ki * integ + Kd * de;
    const uc = clampf(u, -SAT, SAT);
    if (Ki > 1e-6 && u !== uc) { integ -= (u - uc) / Ki; integ = clampf(integ, -I_LIMIT, I_LIMIT); }
    p.stepControlPeriod(uc);
    ys.push(p.theta);
  }
  const peak = Math.max(...ys);
  const overshoot = ((peak - stepDeg) / stepDeg) * 100;
  const ssVal = ys.slice(-Math.round(0.5 / CTRL_DT)).reduce((s, v) => s + v, 0) / Math.round(0.5 / CTRL_DT);
  const ssErr = stepDeg - ssVal;
  // 整定時間: 以降ずっと ±5% に入る最初の時刻
  const band = 0.05 * stepDeg;
  let settleTick = nTicks;
  for (let i = 0; i < ys.length; i++) {
    let ok = true;
    for (let j = i; j < ys.length; j++) if (Math.abs(ys[j] - stepDeg) > band) { ok = false; break; }
    if (ok) { settleTick = i; break; }
  }
  return { overshoot, ssErr, settleSec: settleTick * CTRL_DT, peak };
}

// ============================================================
//  実行
// ============================================================
function banner(t) { console.log("\n" + "═".repeat(64) + "\n  " + t + "\n" + "═".repeat(64)); }

// --- シナリオ A: 標準的な機体 (発振する=正常チューニング) ---
banner("シナリオ A: 標準機体 (roll軸相当) — 正常系");
const plantA = { wn: 2 * Math.PI * 1.2, zeta: 0.15, K: 0.41, delaySec: 0.05 };
console.log(`Plant: 固有 ${(plantA.wn / (2 * Math.PI)).toFixed(2)}Hz, ζ=${plantA.zeta}, 舵効き K=${plantA.K}, 遅れ=${plantA.delaySec * 1000}ms`);

const trueA = trueUltimate(plantA);
console.log(`\n[独立検証] 真の発振境界:  Ku_true ≈ ${trueA.Ku.toFixed(3)},  Tu_true ≈ ${trueA.Tu.toFixed(3)} s`);

console.log(`\n[AutoTuner] Kp スイープ (kpStart=${DEFAULT_CONFIG.kpStart}, step=${DEFAULT_CONFIG.kpStep}, kick=${DEFAULT_CONFIG.kickDeg}°):`);
const tunedA = autoTune(new Plant(plantA), DEFAULT_CONFIG, { verbose: true });

if (tunedA.result === "done") {
  console.log(`\n[AutoTuner] 検出:  Ku=${tunedA.Ku.toFixed(3)},  Tu=${tunedA.Tu.toFixed(3)} s`);
  const dKu = Math.abs(tunedA.Ku - trueA.Ku);
  const dTu = Math.abs(tunedA.Tu - trueA.Tu);
  console.log(`           誤差:  ΔKu=${dKu.toFixed(3)} (${((dKu / trueA.Ku) * 100).toFixed(0)}%),  ΔTu=${dTu.toFixed(3)}s (${((dTu / trueA.Tu) * 100).toFixed(0)}%)`);
  // grid 量子化分 (kpStep) を許容
  const kuOK = dKu <= DEFAULT_CONFIG.kpStep + 1e-9;
  const tuOK = dTu / trueA.Tu <= 0.25;
  console.log(`           判定:  Ku ${kuOK ? "✓ grid 内一致" : "✗ ずれ大"} / Tu ${tuOK ? "✓ 25%以内" : "✗ ずれ大"}`);

  for (const rule of ["classic", "no-overshoot"]) {
    const g = zieglerNichols(tunedA.Ku, tunedA.Tu, rule);
    const sr = stepResponse(plantA, g, 10);
    console.log(
      `\n[ZN:${rule}] Kp=${g.Kp.toFixed(3)} Ki=${g.Ki.toFixed(3)} Kd=${g.Kd.toFixed(3)}` +
      `  → step10°: 行き過ぎ ${sr.overshoot.toFixed(0)}%, 整定 ${sr.settleSec.toFixed(2)}s, 定常偏差 ${sr.ssErr.toFixed(2)}°`,
    );
    const stable = sr.peak < 10 * 3 && sr.settleSec < 5 && Math.abs(sr.ssErr) < 2;
    console.log(`           安定性: ${stable ? "✓ 安定・実用域" : "✗ 要確認"}`);
  }
} else {
  console.log(`\n[AutoTuner] 結果: ${tunedA.result}`);
}

// --- シナリオ B: 過減衰・低舵効き (kpMax まで発振せず=failed を確認) ---
banner("シナリオ B: 過減衰・舵効き弱 — failed 分岐の確認");
const plantB = { wn: 2 * Math.PI * 0.8, zeta: 1.3, K: 0.25, delaySec: 0.01 };
console.log(`Plant: ζ=${plantB.zeta} (過減衰), K=${plantB.K} (弱), 遅れ=${plantB.delaySec * 1000}ms`);
const tunedB = autoTune(new Plant(plantB), DEFAULT_CONFIG, { verbose: true });
console.log(`\n[AutoTuner] 結果: ${tunedB.result}  → 期待: failed`);
console.log(`判定: ${tunedB.result === "failed" ? "✓ 正しく『発振せず』と報告" : "✗ 想定外"}`);

// --- シナリオ C: 安全中断 (記録中に safeAngle 超過=aborted を確認) ---
banner("シナリオ C: 安全中断 (aborted 分岐) の確認");
const plantC = { wn: 2 * Math.PI * 1.2, zeta: 0.05, K: 1.6, delaySec: 0.07 };
const cfgC = { ...DEFAULT_CONFIG, safeAngleDeg: 12, kickDeg: 10 };
console.log(`Plant: ζ=0.05 (ほぼ無減衰), K=1.6 (強), 遅れ70ms。中断角を ${cfgC.safeAngleDeg}° に絞る`);
const tunedC = autoTune(new Plant(plantC), cfgC, { verbose: true });
console.log(`\n[AutoTuner] 結果: ${tunedC.result}  → 期待: aborted (安全中断)`);
console.log(`判定: ${tunedC.result === "aborted" ? "✓ 偏差超過で安全中断" : "△ " + tunedC.result + " (発振検出が先行)"}`);

banner("サマリ");
console.log(`A 正常系   : ${tunedA.result === "done" ? "✓ done — Ku/Tu 検出→PID 算出→安定確認" : "✗ " + tunedA.result}`);
console.log(`B 過減衰   : ${tunedB.result === "failed" ? "✓ failed を正しく報告" : "✗ " + tunedB.result}`);
console.log(`C 安全中断 : ${tunedC.result === "aborted" ? "✓ aborted を正しく報告" : "△ " + tunedC.result}`);
