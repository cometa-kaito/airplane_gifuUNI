# 自律滑空機 制御戦略レポート — 一般論との比較と改善方針

| 項目 | 内容 |
|---|---|
| 対象 | `自作/` リポジトリ（nRF52840 機体・ESP32-C3 双方向ブリッジ・PyQt 地上局・Next.js WebUI） |
| 比較対象 | 授業公式サンプル (`30_GliderSample/example03`, `example-4pin_flight`, `Lesson17`) と PDF 教材 |
| 機体仕様 | XIAO nRF52840 Sense + LSM6DS3 (6軸IMU) + ESP32-C3 + EMax ES9051/ES9251-2 サーボ + Lipo |
| 飛行方式 | ゴム射出台から発射し、最遠到達距離を競う（PDF p.2 参照） |
| 機体構成 | エルロン2枚 (D0=右 / D1=左) + エレベータ (D2)。ラダー無し |
| 報告日 | 2026-05-15 (初稿) / 2026-05-15 改善実装 |

## 実装ステータス (2026-05-15)

| 優先度 | 項目 | 状態 | 該当コミット範囲 |
|---|---|---|---|
| 🔴 P0-1 | 射出検出 + フェーズマシン | ✅ 実装済 | Flight Phase Machine (DISARMED/PRELAUNCH/LAUNCH/GLIDE/LANDED) を `glider_nRF52840.ino` に追加 |
| 🔴 P0-2 | PID 目標の動的化と feed-forward | ✅ 実装済 | `currentTargetPitch()` で phase 依存目標、`climb_ff` でエレベータ feed-forward |
| 🔴 P0-3 | D 項にジャイロを直接使う | ✅ 実装済 | `d_source gyro` (既定) / `error` (互換) を `dSource` で切替 |
| 🟠 P1-1 | 制御ループ周期を 100Hz に | ⏸ 保留 | dt 整合・テレメトリ帯域の検証が必要、競技後の課題に |
| 🟠 P1-2 | Madgwick beta=0.033 | 📝 TODO | `MadgwickAHRS` ライブラリの beta が private のため設定不可。Adafruit_AHRS への置換 or ライブラリパッチが将来課題 (firmware にコメント残し) |
| 🟠 P1-3 | 積分項リミットの物理化 | ✅ 実装済 | `integralLimit` を 200 → 50 に縮小 |
| 🟠 P1-4 | zero キャリブの NVS 保存 | ⏸ 保留 | フィールドで毎回 zero を打つ手間あり。InternalFS 連携は将来課題 |
| 🟡 P2-1 | テレメトリに PID 内部状態追加 | 🟦 部分実装 | `phase` と `accel_g` を 16/17 列目に追加。PID 個別成分は次回 |
| 🟡 P2-2 | 地上局でフライト自動ロギング | ✅ 実装済 | `ground_station.py` 起動と同時に `logs/flight_*.csv` へ自動保存 (--no-log で無効化可) |
| 🟡 P2-3 | ステップ応答 + Z-N 自動チューニング | ⏸ 保留 | UI に Step Response 取得ボタンを追加する案、競技直前の余力次第 |
| 🟡 P2-4 | WebUI / PyQt の役割分離 | 📝 README で明示 | 機能は両者で並行運用、README で「PyQt = 主力、WebUI = 並行/解析」を明記済 |
| 🟡 P2-5 | yaw を不確か表示 | ⏸ 保留 | 競技に影響しないため後回し |
| 🟢 P3 | カスケード PID / ピトー / モデル同定 | ⏸ 保留 | 競技後の発展テーマ |

**現時点の到達点**: 「単発射出グライダーとしてのフェーズ自動切替」「PID 部品の質的改善」「ロガー確実化」を達成。次の試験飛行で投擲しきい値・climb_pitch・glide_pitch・Kd の実機チューニング段階に入れる。

---

## 1. 一般的な自律滑空機の制御戦略（背景知識）

### 1.1 戦略の大分類

実機・モデル機・水中グライダーまで含めた制御戦略は、概ね次の階層に整理できる。

| 階層 | 役割 | 自作機が今いる位置 |
|---|---|---|
| **誘導 (Guidance)** | 目標地点・経路 (waypoint, thermal centering) を決める | 未実装。射出台から手投げ方向に飛ばすだけ |
| **航法 (Navigation)** | 自機の位置・姿勢・速度を推定 | 6軸 IMU + Madgwick で **姿勢のみ**（位置・対気速度は無し） |
| **制御 (Control)** | サーボ操作量を決定 | **3軸独立 PID + ミキシング**を実装済み |
| **アクチュエータ** | エルロン・エレベータ・(ラダー) | エルロン差動 + エレベータの 3 サーボ |

### 1.2 飛行段階 (Flight Phase) ベースの制御切換

授業 PDF p.4 が示す通り、典型的な投擲・射出グライダーは「**フェーズマシン**」で制御則を切り替える戦略が一般的：

```
[射出] → [上昇 (climb-out)] → [遷移 (transition)] → [滑空 (glide)] → [(任意) 機首下げ着地]
```

- ハンドランチグライダー (HLG / DLG) の世界では、**transition** が最大到達距離を決める律速段階とされる ([Gryffin Aero - Hand Launch Glider Tips](https://gryffinaero.com/models/ffpages/tips/hlgtips.html))
- 各フェーズで **目標 pitch 角を切り替える**のが基本：
  - 上昇中: 機首を高く保つ (例 +20°〜+45°)
  - 遷移直後: 失速しない範囲で速やかに水平に
  - 滑空中: わずかに機首上げ (例 +2°〜+5°、最良滑空角)
- フェーズ切換のトリガには **加速度** (射出時の高 G、または失速側で 0G に近づく)・**時間** (射出後 t_climb 秒で遷移) の両方がよく使われる

### 1.3 角度制御 vs 角速度制御 (cascade)

- **Inner loop (rate)**: ジャイロ生値で角速度を抑え、外乱・突風に強い
- **Outer loop (attitude)**: 姿勢角を目標に追従させる
- ArduPilot Plane / PX4 など本格 FBW はこの 2 段カスケードが標準 ([ArduPilot Plane docs](https://ardupilot.org/plane/docs/soaring.html))
- Lesson17 の D 項に **`-Kd * gy`** (ジャイロ直接) を入れているのは、この cascade の最簡形に相当
- 自作機はカスケード化されておらず、D 項が誤差差分 `(e - prevE)/dt` のみのため、**ノイズの増幅と位相遅れ**を抱えがち

### 1.4 ソアリング (上昇気流活用)

- 本プロジェクトはゴム射出のため動力なし → 純グライダー
- ArduPilot は SOAR_ALT_MIN を超えるとスロットルを 0 にしてサーマル探知に入り、30〜45°バンクで旋回する戦略を持つ ([ArduPilot Soaring](https://ardupilot.org/plane/docs/soaring.html))
- 競技時間と探索距離が短いため本機ではサーマル探知は無理だが、「**最小沈下率**で滑空する pitch 目標」は流用できる思想

---

## 2. 自作プログラムの構造と特徴

### 2.1 ディレクトリ構成 (実体)

```
自作/
├── arduino/
│   ├── glider_nRF52840/             3軸 PID + ミキシング + フェイルセーフ + WDT
│   ├── glider_ESP32C3_aircraft/     機体側 ESP-NOW ブリッジ (Serial1 ⇔ 無線、暗号化、NVS ペアリング)
│   └── glider_ESP32C3_ground/       地上側 ESP-NOW ブリッジ (USB ⇔ 無線)
├── python_viewer/
│   ├── ground_station.py            PyQt6 + pyqtgraph + 3D + WebSocket サーバ (主力地上局)
│   ├── glider_viewer3d.py           3D 単独ビューア
│   ├── viewer_serialsend.py         2D 標準ビューア
│   └── paperplane_glider.py         ミニ 3D ビューア
├── webui/                           Next.js (TypeScript) 製 WebUI（WebSocket 経由）
├── docs/                            HARDWARE_MAC / WIRING / COMMANDS / SETUP
└── logs/                            飛行 CSV ログ
```

### 2.2 制御パイプライン (`glider_nRF52840.ino`)

```
LSM6DS3 (1.66kHz ODR)
   ↓
Madgwick AHRS (6軸 / 30Hz, beta デフォルト)
   ↓                                          ┌── attitudeOffset 補正 (zero/unzero)
Q[roll, pitch, yaw] ──┬───────────────────────┤
   ↓                   │                      ├── tiltSafeguard (|tilt|>60° → MANUAL)
3軸独立 PID            │                      └── failsafe (uplink loss)
   ├ P : Kp * e        │
   ├ I : Ki * Σe·dt    (clip ±200)
   └ D : Kd * α-LPF((e - prevE)/dt)   α=0.85 (cutoff ~0.84Hz)
   ↓
ミキシング:
  D0 (右エルロン) = trim[0] + (+1) * u_roll
  D1 (左エルロン) = trim[1] + (-1) * u_roll
  D2 (エレベータ) = trim[2] + u_pitch
   ↓
servo.write() (値変化時のみ)
```

### 2.3 強み — 公式サンプルより進んでいる点

| 項目 | 自作 | example03 | example-4pin |
|---|---|---|---|
| ループ周期の絶対時刻ベース固定 | ✅ `delayMicroseconds` 補正 | ❌ `delay(10)` のみ | ❌ `delay(15)` |
| WDT (loop ブロック検出) | ✅ nRF52840 内蔵 + ESP32 task WDT | ❌ | ❌ |
| アップリンク・フェイルセーフ | ✅ `failsafe <ms>` で MANUAL 復帰 | ❌ | ❌ |
| 過傾斜保護 (tilt safeguard) | ✅ `safe_angle <deg>` | ❌ | ❌ |
| D 項 LPF | ✅ 1次 IIR、`dfilter` で動的調整 | ❌ | ❌ |
| 取付角キャリブレーション | ✅ `zero` / `unzero` (RAM のみ) | ❌ | ❌ |
| 通信暗号化 + NVS ペアリング | ✅ ESP-NOW + PMK/LMK | ❌ MAC ハードコード | ❌ |
| 地上局 (Live Telemetry + 3D) | ✅ PyQt + pyqtgraph + GLViewWidget | ❌ シリアルモニタのみ | ❌ |
| WebUI (ブラウザ操作) | ✅ Next.js + WebSocket | ❌ | ❌ |
| サーボ ぴくぴき抑制 | ✅ 値変化時のみ `write` | ❌ 毎回 `write` | ❌ 毎回 `write` |

### 2.4 公式サンプルから取り込んでいない設計要素

| 項目 | example03 / 4pin / Lesson17 | 自作 |
|---|---|---|
| **飛行フェーズマシン** | ✅ MANUAL→AUTO→START→REAL_FLIGHT (example03)、3 phase 切替 (4pin) | ❌ 単一 PID のみ |
| **射出検出** | ✅ `Acc(z) < -0.6` 3秒 (example03)、`ax > 1.0` (Lesson17) | ❌ |
| **フェーズ別目標姿勢** | ✅ THETA0/1/2 切替 (4pin、機首上げ→水平→落下) | ❌ target 固定 (0,0,0) |
| **D 項にジャイロ直接** | ✅ Lesson17 が `-Kd * gy` | ❌ 誤差差分のみ |
| **積分は射出後のみ** | ✅ Lesson17 (`if (started) integrate`) | ❌ AUTO/PID 中は常に積分 |

---

## 3. 飛ばし方 (運用) と、それに対するコードの整合性

PDF p.2 が示す運用：①設置 → ②引っ張る → ③飛ばす → ④落ちたところで終了。**約 5〜10 秒の単発フライト**。

| 飛行段階 | PDF / HLG 一般論 | 自作機の現挙動 |
|---|---|---|
| ① 設置 | 機体水平、サーボ中立 | `MANUAL + trim=0` で OK。ただし `zero` が再起動でクリアされるため毎回キャリブが必要 |
| ② 引っ張る | ゴムを引く＝静止状態 | 何もしない |
| ③ 射出 (高 G) | 3〜10 G 程度の前向き加速 | **検出機構なし**。手動で `auto`→`3` (PID) を打つ必要があり、人手が間に合わない可能性 |
| ④ 上昇 (climb-out) | 機首上げで運動量を高度に変換 | target_pitch=0 のまま → エレベータ neutral で水平飛行を強制し、せっかくの上昇エネルギーを使い切れない |
| ⑤ 遷移 | 緩やかに水平へ | 同上 |
| ⑥ 滑空 | 微小機首上げで最良滑空角 | target_pitch=0 のままなのでまずまず動くが、最適ではない |
| ⑦ 着地 | 過度なバンク阻止 | tiltSafeguard が 60° で MANUAL+trim=0 に戻す → エルロン中立で水平復帰しようとするので比較的安全 |

つまり「単一モード型 (PDF 例②)」さえ完全には実現できておらず、特に **③→④ の射出検出の自動化が無い**ので、現状は地上局オペレーターの手動モード切替が前提の運用になっている。

---

## 4. ログ実機データから観測されたコード課題

`logs/flight_20260515_145341.csv` (1568〜1641 行付近) を解析：

| 観測 | 数値 | 示唆 |
|---|---|---|
| 平均 dt_ms | 31 ms (~32 Hz) | コメントに合致。30Hz 設定 OK |
| 静止時 az | 0.988〜0.992 g | 校正は妥当 (1G に近い) |
| 静止時 gy ノイズ | RMS ≒ 3〜5 deg/s | LSM6DS3 の典型値、許容範囲 |
| 静止時 pitch | 0.3°前後 (微変動) | OK |
| 静止時 yaw | 緩やかにドリフト (0→-3°) | **6軸では仕方ない**。ただしテレメトリで意味あるように見えてしまう UI 上の問題 |
| seq 1592 周辺 | gx=-42, gy=46, gz=-55 (急変) | 手で揺すったショック → 復帰している。挙動は健全 |
| s0/s1/s2 | 88〜92 で振動 (MANUAL) | サーボぴくぴき対策コードがあっても trim=0 と s2=89 で 1deg 差は出ている (ESC 値が決定的でない可能性) |

---

## 5. 改善方針（優先度順）

### 🔴 P0 — 飛ばす前に必須

#### P0-1. 射出検出 + フェーズマシンの導入

PDF 戦略①（飛行モードによる制御切換）への対応。`glider_nRF52840.ino` に以下のステートを実装：

```cpp
enum FlightPhase {
  PHASE_PRELAUNCH = 0,   // 静止待機 (MANUAL trim 維持)
  PHASE_LAUNCH    = 1,   // 高 G 検出 〜 t_climb_ms 経過まで (機首上げ目標)
  PHASE_GLIDE     = 2,   // それ以降 (最良滑空 pitch)
  PHASE_LANDED    = 3,   // 着地検出 (低 G 持続) → サーボ中立
};

// 検出条件
const float LAUNCH_ACCEL_G   = 3.0f;   // ax > 3G で射出と判定
const uint32_t T_CLIMB_MS    = 1500;   // 上昇フェーズ持続時間
const float GLIDE_TARGET_PITCH = 3.0f; // 最良滑空 pitch
const float CLIMB_TARGET_PITCH = 15.0f;// 上昇 pitch
```

- `LAUNCH_ACCEL_G` は射出ゴムの強さに合わせて要キャリブ → コマンド `launch_g <value>` で実機調整可能に
- フェーズ遷移時は **積分項 + D-LPF 状態をクリア** (既存の `prevBase != prevSub` ロジックを流用可)
- 落下フェーズ (PHASE_LANDED) は |az|<0.3G が 1秒持続で判定し、サーボを中立 + I=0 に戻すと衝撃損傷を減らせる

#### P0-2. PID 目標の動的化と feed-forward

```cpp
float currentTargetPitch() {
  switch (phase) {
    case PHASE_LAUNCH: return CLIMB_TARGET_PITCH;
    case PHASE_GLIDE:  return GLIDE_TARGET_PITCH;
    default:           return 0.0f;
  }
}

// PID の e 計算
float e = currentTargetPitch() - Q[1];
```

加えて、フェーズに応じた **feed-forward オフセット**（射出直後はエレベータを +5°保持して機首上げを補助）を入れると効きが早い。

#### P0-3. D 項にジャイロを直接使う (Lesson17 流)

現在の `(e - prevE)/dt` 方式は dt=33ms で IMU ノイズが約 30倍に増幅される。Lesson17 のように：

```cpp
// 角度差分微分の代わりに、ジャイロを「角速度の負号」として使う
// roll は -gx 相当、pitch は -gy 相当 (符号は機体取付による)
float de_roll  = -gx;   // deg/s
float de_pitch = -gy;
u_roll  = Kp[0]*e_roll  + Ki[0]*I_roll  + Kd[0]*de_roll;
u_pitch = Kp[1]*e_pitch + Ki[1]*I_pitch + Kd[1]*de_pitch;
```

これで dfilter LPF (cutoff 0.84Hz は PID 帯域に近すぎ) を撤去できる。Kd の単位が変わるので、再チューニング必要 (1/30 倍くらいから始める)。

### 🟠 P1 — 飛行性能を上げる

#### P1-1. 制御ループ周期を上げる

- 現状 30Hz は IMU ノイズと dt 整合のため。サーボ更新は ES9051 で max 50Hz、ES9251-2 (デジタル) で 200Hz 以上対応
- 目標 100Hz (Lesson17 と同じ) でループを回し、Madgwick `filter.begin(100)` に整合させる
- IMU は I2C 400kHz なら read を含めて 100Hz は十分余裕がある (現状の serial print が支配的なら、テレメトリだけ 30Hz に落として制御は 100Hz というレート分離が望ましい)

#### P1-2. Madgwick beta の明示設定

`MadgwickAHRS` ライブラリは `begin()` だけで beta=0.1f がデフォルト。論文推奨は **0.033 (IMU 構成)** ([Madgwick 論文](https://courses.cs.washington.edu/courses/cse466/14au/labs/l4/madgwick_internal_report.pdf))。

```cpp
filter.begin(100);
// 内部で beta が hidden ならソース上書き、または自前 Mahony に置換
```

dynamic accuracy の改善が見込める。

#### P1-3. 積分項リミットを物理意味に合わせる

現状 `integralLimit = 200`、`Ki=0.2` で I 単独で ±40°相当のサーボ操作量。サーボ可動が ±90°、ミキシング後に他の項と足して飽和する余地を考えると、I 項単独は **±10°〜20°相当** に抑えるべき。

```cpp
// e.g. roll は ±10° 相当を上限に
const float integralLimit = 50.0f;   // Ki=0.2 で 10° に相当
```

#### P1-4. `zero` キャリブを NVS に保存

再起動でクリアされる現仕様だと、毎フライトの前に手で `zero` を打つ手間が発生し、**現場で忘れがち**。nRF52840 の `InternalFS` (LittleFS) を使って永続化：

```cpp
// LittleFS でファイル化、起動時に load
saveAttitudeOffset();
loadAttitudeOffset();
// CLI: `zero_save` / `zero_load` / `zero_clear`
```

### 🟡 P2 — 開発・運用体験

#### P2-1. テレメトリに PID 内部状態を追加

現 15列に加えて、CSV に以下を追加（PROTOCOL_original.md と互換のため `tlm_ext on` でオプション化）：
- `phase` (0/1/2/3) — フェーズマシン状態
- `target_pitch`, `target_roll`
- `pid_p_pitch`, `pid_i_pitch`, `pid_d_pitch` — 各成分
- 同 roll
- `accel_g` — sqrt(ax²+ay²+az²) (射出 G の確認用)

これで地上局で「I項が暴走してないか」「D項のノイズはどうか」を可視化できる。

#### P2-2. 地上局でのフライト自動ロギング

現在は `logs/flight_*.csv` が WebUI 経由で保存されているが、`ground_station.py` 自体には自動保存ロジックが書かれていない。`SerialIO` に：

```python
def __init__(..., log_dir: Path = Path("logs")):
    self._log_file = log_dir / f"flight_{datetime.now():%Y%m%d_%H%M%S}.csv"
    self._log_handle = open(self._log_file, "w", encoding="utf-8")
    self._log_handle.write(",".join(TELEMETRY_FIELDS + ["wall_ms"]) + "\n")
```

を入れて、起動と同時に必ず CSV が残る運用にすると競技時の「ログ取り忘れ」を防げる。

#### P2-3. ステップ応答自動取得 → Z-N 自動チューニング支援

PDF (PID p.10) で紹介された **限界感度法 (Ziegler-Nichols)** の手作業を地上局でサポート：
- ボタン「Step Response (Pitch +10°)」を押すと、`target p 10` を打って 3 秒分の応答 CSV を保存
- グラフから持続振動になる Kp を試行で探し、振動周期 Tc から PID ゲインを自動算出
- 結果を `kp p X / ki p Y / kd p Z` で書き戻す

#### P2-4. WebUI と PyQt 地上局の役割分離

現状両方が同等機能を持って二重メンテになりがち：
- **PyQt (`ground_station.py`)**: フィールドオペレータ用 — シリアル直接、低遅延、フライト中の主力
- **WebUI (`webui/`)**: 観戦者・解析者用 — WebSocket 経由のリードオンリー、コマンドはオフ既定 (現に `Accept WS commands` 既定 OFF)

を `README.md` に明記し、WebUI 側で書き込み系 UI を弱める or 開発者モード化する。

#### P2-5. ヨーの扱いを UI 上で「不確か」表示

6軸 IMU では yaw はジャイロ積分のみで磁気補正がなく、徐々にドリフトする。`ground_station.py` の "YAW" 数値表示を **時間とともに灰色になる** など、視覚的に信頼性が低いことを示すと誤解を防げる。または yaw を完全に隠す。

### 🟢 P3 — 競技後の発展

#### P3-1. カスケード (rate inner / attitude outer) PID

- 外側 PID で目標角速度を生成 → 内側 PID でジャイロ追従
- 突風・乱気流に強くなる
- ただし計算量・チューニング工数が倍増 → 競技後の実験テーマ向き

#### P3-2. 対気速度ピトー管 / 気圧計の追加

- 速度マネジメント (失速回避、最良滑空速度キープ) ができるようになる
- BMP280 などの気圧センサで高度→沈下率推定 (本機の競技時間内では微妙だが)

#### P3-3. ログから機体動特性を同定 → モデルベース制御

- ログの (servo_pitch_deg, pitch_rate, pitch) から伝達関数同定
- LQR / MPC のような最適制御の出発点

---

## 6. すぐ着手できる最短ルート

「次の試験飛行までに最低限やるべきこと」を 3 ステップに絞ると：

1. **`glider_nRF52840.ino` にフェーズマシン (PRELAUNCH/LAUNCH/GLIDE/LANDED) を追加**
   — 射出検出 (ax > 3G) と上昇フェーズの target_pitch を実装。example03 の `mode_select` を参考に
2. **D 項をジャイロ直接方式に切替** (Lesson17 流) → `dfilter` 撤去
3. **`ground_station.py` に CSV 自動保存と「飛行フェーズ表示」を追加** — 現場での状況把握とログ確実性

これだけで「単発射出グライダーとしての到達距離」は体感で改善するはず。

---

## 7. 参考資料

### 授業内
- `10_授業資料/10_初回制御説明（全体）_2026.pdf` — 飛行戦略の例 (p.4)
- `10_授業資料/20_PID制御（全体）_2026.pdf` — Z-N チューニング (p.10〜11)
- `30_GliderSample/example03/example03.ino` — 加速度ベース射出検出 + REAL_FLIGHT
- `30_GliderSample/example-4pin_flight/example-4pin_flight.ino` — 3 フェーズ目標姿勢切替
- `10_Lesson/Lesson17/Lesson17.ino` — 単軸 PID + ジャイロ D 項 + 射出検出フラグ

### 外部
- [ArduPilot Plane — Soaring](https://ardupilot.org/plane/docs/soaring.html) — 本格 FBW グライダーの自動滑空・サーマリング戦略
- [Gryffin Aero — Hand Launch Glider Tips](https://gryffinaero.com/models/ffpages/tips/hlgtips.html) — 自由飛行 HLG の遷移トリミング
- [AMA Flight School — Free-Flight Trimming of a Glider](https://www.amaflightschool.org/diy/free-flight-trimming-glider) — 競技用射出グライダーのトリム手順
- [Madgwick Filter Internal Report](https://courses.cs.washington.edu/courses/cse466/14au/labs/l4/madgwick_internal_report.pdf) — IMU 構成 beta=0.033 の根拠
- [Hackaday — PX4 Glider](https://hackaday.com/2019/03/27/running-a-glider-with-the-px4-flight-controller/) — 純グライダーへの本格 FC 適用例

### コミュニティ
- [ArduPilot Discourse — Simplest Controller for a Glider](https://discuss.ardupilot.org/t/simplest-controller-for-a-glider/104361) — ミニマリスト派の議論
- [GitHub - dfvella/autopilot](https://github.com/dfvella/autopilot) — Arduino ベース RC 機 FBW の参考実装
