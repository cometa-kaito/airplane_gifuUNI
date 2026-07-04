# 無線コマンド一覧

シリアルモニタ（地上側 #1 の COM）または Python ビューアからマイコンへ送れるコマンド一覧。

すべて **行末 LF（`\n`）区切り**、**115200 baud**。

## モード切替

| 入力 | 動作 | 応答 |
|---|---|---|
| `m` または `manual` | MANUAL モード（PID 停止、サーボ = trim） | `[MODE] MANUAL` |
| `a` または `auto` | AUTO モード（PID 制御開始） | `[MODE] AUTO` |
| `1` | AUTO/P サブモード | `[MODE] AUTO/P` |
| `2` | AUTO/PD サブモード | `[MODE] AUTO/PD` |
| `3` | AUTO/PID サブモード | `[MODE] AUTO/PID` |

## ゲイン・目標角設定

軸指定: `0`/`1`/`2` または `r`/`p`/`y` または `roll`/`pitch`/`yaw`

| 入力例 | 動作 |
|---|---|
| `kp p 1.5` | pitch の Kp を 1.5 に |
| `ki r 0.3` | roll の Ki を 0.3 に |
| `kd y 0.05` | yaw の Kd を 0.05 に |
| `target p 5.0` | pitch 目標角を 5.0° に |
| `target r 0` | roll 目標角を 0° に |

応答例：
```
[PARAM] kp axis=1 value=1.5000
```

## サーボ個別操作（エルロン構成）

`-90 〜 +90` 度の範囲で指定（基準角 trim）。MANUAL でも AUTO でも有効。

| 入力例 | 動作 |
|---|---|
| `s0 5` | 右エルロン (D0) の trim = +5° |
| `s1 -3` | 左エルロン (D1) の trim = -3° |
| `s2 0` | エレベータ (D2) の trim = 0°（中央） |

- **MANUAL モード**：trim そのままがサーボ角（PID 不使用、手動操舵）
- **AUTO モード**：trim にミキシング後の PID 出力が加算される
  - 右エルロン = `trim[0] + (+1) × u_roll`
  - 左エルロン = `trim[1] + (-1) × u_roll`（左右逆位相）
  - エレベータ = `trim[2] + u_pitch`

### ミキシング係数（取付位相補正）

| 入力例 | 動作 |
|---|---|
| `mixR 1.0` | 右エルロン係数（既定 +1.0） |
| `mixL -1.0` | 左エルロン係数（既定 -1.0） |
| `mixR -1.0 mixL 1.0` | 左右位相を入れ替え |
| `mixL 1.0` | フラッペロン的に左右同位相にする |

## その他

| 入力 | 動作 |
|---|---|
| `status` | 現在のモード・全ゲイン・目標角・trim・テレメトリ ON/OFF・フェイルセーフ設定を表示 |
| `help` または `?` | コマンドヘルプ全文表示 |
| `tlm on` | テレメトリ送信を再開 |
| `tlm off` | テレメトリ送信を停止（コマンド応答だけになる） |
| `ping` | ハートビート。応答を返さず `lastUplinkMs` だけ更新する。WebUI が ~300ms 毎に自動送信し `failsafe` 発火を防ぐ |
| `failsafe <ms>` | アップリンク途絶でフェイルセーフ発動するまでの ms を設定（既定 1500、`0` で無効） |
| `safe_angle <deg>` | 姿勢角しきい値（`|roll|` または `|pitch|` がこれを超えると AUTO→MANUAL に強制復帰）。既定 60、`0` で無効、**`>=180` も無効 (Madgwick の境界誤動作を避けるため)**。**飛行中 (LAUNCH/GLIDE) と風洞 (WT) では抑制される** — 空中で PID を切る = 制御放棄 = 墜落のため。地上ベンチで AUTO を試すときの保護として機能する |
| `tilt_limit <deg>` | `safe_angle` のエイリアス |
| `dfilter <alpha>` | D 項に掛ける 1次 IIR LPF 係数 (0..0.99)。**既定 0.85** (30Hz サンプリングで cutoff ~0.84Hz)。**0 で生 D**、大きいほど滑らかになる代わりに応答が遅延。サーボの「ぴくぴく」抑制に使用 |
| `zero` | **取付角キャリブレーション**: 今の Madgwick 出力 (roll/pitch/yaw) を「0°」基準として記録。以降の PID / safeguard / テレメトリ はこの基準からの相対角になる。RAM 保持 (再起動でクリア)。フライト前に機体を水平に置いて実行 |
| `unzero` | `zero` で設定したオフセットを解除して生 IMU 出力に戻す |
| `arm` | **フェーズマシン開始**: DISARMED → PRELAUNCH。`|a|>launch_g` の連続検出を待ち、検知すると LAUNCH → GLIDE へ自動遷移。Arm 中は failsafe が抑制される |
| `disarm` | DISARMED に戻す。**trim は維持**（PRELAUNCH キャンセル時にユーザ設定値を守る用途、緊急脱出にも） |
| `land` | **飛行終了**: trim を 0 にリセットしてから DISARMED に戻す。GLIDE / LAUNCH から終わらせる主要コマンド（旧 PHASE_LANDED は DISARMED に統合済） |
| `phase` | 現在フェーズと経過時間を表示 |
| `launch_g <g>` | 投擲判定の加速度しきい値 [g]。既定 2.5、範囲 1.0..8.0 |
| `launch_grace <ms>` | **投擲検知直後の PID ゼロホールド時間** [ms]。この間 PID 出力は 0 のまま、エレベータは trim + `climb_ff` で保持（Madgwick の投擲ショック復帰待ち）。既定 500、範囲 0..5000（0 で無効 = 検知と同時に PID 開始）。2026-07 以降のファームで対応 |
| `climb_ms <ms>` | LAUNCH フェーズの持続時間 [ms]。既定 1500、範囲 200..10000 |
| `climb_pitch <deg>` | LAUNCH 中の目標 pitch（機首上げ）。既定 +15°、範囲 -45..60 |
| `climb_ff <deg>` | LAUNCH 中のエレベータ feed-forward 加算。既定 +5°、範囲 -90..90（最終舵角が ±90° でクリップされるため実質上限なし。2026-07 より前のファームは -30..30） |
| `glide_pitch <deg>` | GLIDE 中の目標 pitch（最良滑空）。既定 +3°、範囲 -20..30 |
| `d_source <gyro\|error>` | D 項の計算ソース。**既定 gyro**（Lesson17 推奨。ジャイロ生値を直接使用）。`error` で従来の `(e-prevE)/dt + dfilter` に戻る |
| 削除: `landed_g` / `landed_gyro` / `landed_ms` / `glide_timeout` / `landed_impact_g` | **auto-LANDED 検出を全廃したため削除**。送ると `[INFO] auto-LANDED removed. Use \`land\`...` を返す（古い localStorage 互換のため受理だけする） |
| `wt` / `wt_mode` / `windtunnel` | **風洞試験モードへ遷移** (PHASE_WINDTUNNEL)。PID 常時 ON、target は `target p`/`target r` でユーザ操作。tilt safeguard・failsafe・climb_ff すべて抑制。`disarm` で抜ける。**DISARMED からのみ受理** (飛行中の誤入力ガード) |

## 永続化・復帰系（「何があっても飛ぶ」、2026-07 以降のファーム）

全チューニング値（ゲイン・trim・サーボ較正・フェーズ設定・zero オフセット等）を nRF52840 の内蔵フラッシュへ保存し、ブート時に自動復元する。**地上局 PC が現地で使えなくても、較正済み状態で電源投入→投擲だけで飛べる**ようにするための機構。

| 入力 | 動作 |
|---|---|
| `save` | 全チューニング値をフラッシュへ保存（`[SAVE] config -> flash`）。**`arm` / `disarm` / `land` 時にも自動保存される**ので通常は明示的に打つ必要はない。飛行中 (LAUNCH/GLIDE) は拒否（ページ消去 ~85ms がループを止めるため） |
| `wipe` | 保存済み設定を消去。RAM の現在値はそのまま、**次回ブートからコンパイル時デフォルト**に戻る |
| `autoarm on\|off` | **ブート時に自動で PRELAUNCH に入る**（既定 off、設定は即永続化）。PC 無しで「電源 ON → 投げる → 飛ぶ」を実現する。ベンチ作業中に 2.5g 超の衝撃を与えると LAUNCH が発火する点に注意 |
| `launch_now` / `launch_force` | **投擲検知漏れの救済**: PRELAUNCH から LAUNCH を手動強制発火。弱い投擲で `launch_g` に届かず trim 滑空になった場合、uplink が生きていればこれで空中から PID を起動できる |
| `reboot [force]` | ソフトリセット。飛行中 (LAUNCH/GLIDE) は誤爆防止のため `reboot force` のみ受理 |

### 飛行中リセットからの自動復帰

LAUNCH 進入時に「飛行中マーカ」をフラッシュへ記録する（事前消去済みスロットへの 1 ワード書き込み ≈ 41µs なので、飛行中の制御ループを乱さない）。飛行中に**サーボ負荷によるブラウンアウト・WDT・クラッシュ等でリセットが起きても**、ブート時にマーカを検出して:

1. 保存済み構成（trim・ゲイン・較正）を復元
2. **GLIDE フェーズを AUTO/PID で自動再開**（`[RESUME] in-flight reset detected -> GLIDE resume`）
3. 最初の 1.5 秒は PID ゼロホールド（サーボ = 復元 trim）で Madgwick の姿勢収束を待ってから PID 投入

マーカは `land` / `disarm` で消去される。**飛行後に `land` を押さず電源を抜いた場合、次回電源投入時に GLIDE で起動する**（ベンチでサーボが PID で動き出す）ので、`disarm` か `land` を送れば解除される。

armed (PRELAUNCH) 中のリセットは PRELAUNCH に自動復帰し、そのまま投擲待ちを継続する。

ブート時には毎回 `[BOOT] resetreas=0x… WDT/SOFT/PIN/POWERON cfg=loaded/defaults` が出力されるので、「なぜ再起動したのか」を必ず追跡できる。`status` の `[STATUS] cfg=… autoarm=… imu=… marker=…` 行で永続化状態と IMU 健全性を確認できる。

### 取付角キャリブレーション (`zero`)

機体に IMU を取り付けた際、機体が水平に置かれていても **IMU の Z 軸が真上を向くとは限らない**ため、Madgwick の roll/pitch/yaw 出力が 0 にならない (例: roll=+2.5°, pitch=-1.8°)。このまま PID をかけると、機体水平の状態がエラー扱いされて余計な舵を打ってしまう。

`zero` コマンドは、コマンドを受信した瞬間の生 Madgwick 出力を **`attitudeOffset[]`** に記録し、以降:

```
Q_corrected[i] = Q_raw[i] - attitudeOffset[i]
```

として全ての下流処理 (PID, safeguard, テレメトリ) に渡す。これで「今の機体姿勢 = 水平」として扱える。

#### 使い方
1. 機体を水平面 (机/治具など) に置く
2. `zero` を送る → `[PARAM] zero set: roll=2.50 pitch=-1.80 yaw=12.30` のような応答
3. 以降 telemetry の roll/pitch/yaw は ≈ 0 になる
4. やり直したい時は `unzero` で生値に戻し、機体を置き直して再度 `zero`

#### 保持期間
オフセットは **RAM のみ保持**で、再起動 (失敗フェイルセーフ含む) でクリアされる。**フライト前に毎回キャリブレーション**することで、前回の値が誤って残るリスクを排除している。`/status` の `zero=ACTIVE offset=[...]` 行で現在状態を確認可能。

### D 項 LPF (`dfilter`)

PID 制御の D 項 `Kd · (e - prevE) / dt` は dt=33ms (30Hz) で `1/dt = 30` 倍の高周波増幅器として働くため、IMU の高周波ノイズ (機体振動など) がそのままサーボ出力に乗って **「ぴくぴく」する主因** となる。

そこで D 項に 1次 IIR ローパスフィルタを掛ける:

```
dFilt[i] = α · dFilt[i] + (1 - α) · de_raw
u = Kp·e + Ki·∫e + Kd · dFilt
```

30Hz サンプリング (dt=33.3ms) での目安:

| α    | 時定数 τ  | カットオフ | 用途 |
|------|----------|-----------|------|
| 0.0  | 0ms      | (生 D)    | 旧来動作、ノイズ素通し |
| 0.5  | 33ms     | 4.8 Hz    | 軽いフィルタ |
| 0.7  | 78ms     | 2.0 Hz    | 中、応答性重視 |
| 0.85 | 189ms    | 0.84 Hz   | **既定**。多くの機体向け |
| 0.95 | 633ms    | 0.25 Hz   | 過剰フィルタ、ふらつき注意 |

機体応答帯域 (典型 1-3 Hz) を意識して、α=0.85 (cutoff ~0.84 Hz) を既定値に設定。実機ログでサーボ最大ステップ 6°/frame、残差 4.4° が観測されたため、従来の α=0.7 から強めに調整した。設定は `[PARAM] dfilter=<α>` で確認可能。

### 姿勢角しきい値安全装置 (`safe_angle`)

AUTO 中に **`|roll|` または `|pitch|` の最大値** が `safe_angle` を超えると、自動で:

1. `[SAFEGUARD] tilt 65.4deg > 60.0deg -> MANUAL + trim=0` をテレメトリへ送出
2. `MANUAL` モードへ強制切替（PID 出力を遮断）
3. 全サーボ trim を 0°（中立）に戻す
4. 積分項をクリア
5. **ラッチ式** — 一度発動すると、再度 `a` / `auto` / `1` / `2` / `3` で AUTO 系に戻すまで再発動しない

これにより、機体が大きく傾いた時の致命的な落下を抑えつつ、操縦者が状況を確認してから手動で AUTO に戻せます。`safe_angle 0` で無効化できます (推奨は安全装置 ON のまま運用)。

### フェイルセーフ動作

`failsafe <ms>` で設定した時間、機体側マイコンに何も受信が無いと自動で：

1. `[FAILSAFE] uplink lost -> MANUAL + trim=0` をテレメトリへ送出
2. `MANUAL` モードへ強制切替（PID 出力を遮断）
3. 全サーボ trim を 0°（中立）に戻す
4. 積分項をクリア

何かコマンドを 1 行受信した時点で自動的に `[FAILSAFE] cleared (uplink resumed)` を送って通常モードへ復帰する（ただし baseMode は MANUAL のままなので、AUTO に戻すには別途 `a`/`auto`/`1`/`2`/`3` を送る必要あり）。

#### `ping` ハートビートとの関係

WebUI は接続中 **約 300ms 毎に `ping` を自動送信** することで、ユーザーが UI に触っていなくても uplink を生存させ、不要な failsafe 発火を防いでいる (ESP-NOW で ping が数発連続ロストしても発火しない余裕を持たせた間隔)。
また WebUI は設定系コマンド（`s0`/`smid`/`kp` など）を機体の `[PARAM]` エコーで確認し、未達なら自動再送する。`[FAILSAFE] uplink lost` を検知した場合は、リンク回復後にサーボトリムを自動で再同期する。`failsafe 0` で完全に無効化することもできるが、本当に uplink が落ちた時のセーフティが効かなくなる点に注意。Python ground_station 経由で WebUI から `ping` を送る場合は **「Accept WS commands」を ON** にしておく必要がある。

## ESP-NOW ブリッジ ローカルコマンド

地上側のシリアル直接処理（マイコンへは届かない、ローカル応答）：

| 入力 | 動作 |
|---|---|
| `/mac` | 自機・相手機の MAC とチャネルを表示 |
| `/stat` | 送受信統計（sent/recv/bad/replay 件数） |
| `/setpeer XX:XX:XX:XX:XX:XX` | 相手機 MAC を NVS に保存して自動再起動 |
| `/unpair` | NVS の peer をクリアして自動再起動 |
| `/channel <1-13>` | Wi-Fi チャネル変更（両機で同じ値にすること） |
| `/help` | ローカルコマンド一覧 |

## テレメトリ出力（マイコン → PC）

**17 列形式 (現行ファーム)**:
```
seq, t_ms, dt_ms, ax, ay, az, gx, gy, gz, roll, pitch, yaw, s0, s1, s2, phase, accel_g
```

例：
```
1234,567890,33,0.012,0.034,0.998,0.10,-0.20,0.00,1.23,-0.50,0.00,90,92,88,0,1.005
```

- `phase`: 0=DISARMED / 1=PRELAUNCH / 2=LAUNCH / 3=GLIDE / 4=LANDED
- `accel_g`: `sqrt(ax²+ay²+az²)` [g]

30Hz (~33ms) 周期で配信。付属の Python/WebUI viewer は **列数 ≥15 を許容する下位互換実装**で、旧 15 列ファームでも欠損列を 0/計算値で埋めて動作する。

## 典型的な操作シーケンス

```
# 起動・状態確認
status

# ゲイン調整しながら手動でサーボ確認
m            ← MANUAL に
s1 30        ← エレベータを +30° に動かす（動作確認）
s1 0         ← 中央に戻す

# AUTO で PID 制御を開始
a            ← AUTO 起動
3            ← PID サブモード
kp p 1.5     ← pitch P ゲイン
kd p 0.05    ← pitch D ゲイン
target p 0   ← 水平を維持
```

## 自律滑空フロー（Flight Phase Machine）

地上局から逐一 AUTO 操作する必要を無くす自律飛行モード。
WebUI の Step 1〜4 で事前準備を済ませた後、最後に `arm` を送って投擲する。
機体は次のフェーズマシンに従って自動遷移する:

```
DISARMED → (arm) → PRELAUNCH → (|a|>launch_g x2 frames) → LAUNCH (climb-out)
                                                         → (経過 climb_ms) → GLIDE
                                                         → (|az|<landed_g 持続 landed_ms) → LANDED
```

各フェーズの挙動:

| Phase | 制御 | 目標 pitch | サーボ |
|---|---|---|---|
| **DISARMED** | MANUAL | - | trim 値 |
| **PRELAUNCH** | MANUAL | - | trim 値 |
| **LAUNCH** (最初 launch_grace=500ms 既定) | PID ゼロホールド | (高G復帰猶予) | trim + climb_ff |
| **LAUNCH** (残り) | AUTO/PID | climb_pitch (+15°) | PID + climb_ff |
| **GLIDE** | AUTO/PID | glide_pitch (+3°) | PID |
| **LANDED** | MANUAL + trim=0 | - | 中立 (0°) |

### 操作シーケンス

```
# 1. キャリブレーション (機体を水平面に置いた状態で)
zero

# 2. 安全装置を設定
safe_angle 60       ← 姿勢角しきい値 60°
failsafe 1500       ← uplink 失効 1.5s で復帰 (Arm 中は抑制)

# 3. 必要に応じてトリム調整 (手動)
m
s0 0
s1 0
s2 0

# 4. PID ゲインを設定 (D 項は gyro 直接モードが既定)
kp r 1.0
kp p 1.0
kd r 0.02
kd p 0.02

# 5. フェーズマシン パラメータ
launch_g 2.5        ← 投擲しきい値
climb_ms 1500       ← climb-out 持続時間
climb_pitch 15      ← 上昇目標 pitch
glide_pitch 3       ← 滑空目標 pitch

# 6. arm
arm                 ← DISARMED → PRELAUNCH
                    # → [PHASE] -> PRELAUNCH

# 7. 機体を投擲する
                    # → [LAUNCH] detected |a|=3.20g
                    # → [PHASE] -> LAUNCH
                    # ... 1500ms 後 ...
                    # → [PHASE] -> GLIDE
                    # ... 着地検出 ...
                    # → [PHASE] -> LANDED

# 8. 回収後
disarm              ← LANDED → DISARMED
```

## 風洞試験モード (`wt`)

ゴム射出の代わりに、機体を風洞の支柱に固定して PID 応答を測定する用途。
通常のフェーズマシン (DISARMED→PRELAUNCH→...) には乗らず、独立したフェーズ
`PHASE_WINDTUNNEL = 5` に入る。

```
# 1. 機体を風洞内に固定（水平 or 任意の取付角）
# 2. キャリブレーション
zero

# 3. PID ゲイン設定 (通常通り)
kp p 1.0
ki p 0.2
kd p 0.05

# 4. 風洞モードへ
wt                    ← PID 起動、tilt safeguard / failsafe / climb_ff すべて抑制
                      # → [PHASE] -> WINDTUNNEL

# 5. ステップ応答を取りたければ target を順次変更
target p 0
target p 5            ← 0→+5° のステップ
target p 0            ← 整定後、戻す
target p -5
target p 0
target r 5            ← roll も同様にスイープ可能

# 6. 終了
disarm                ← DISARMED に戻り、tilt safeguard / failsafe 復活
```

**振る舞い**:
- **PID 常時 ON**: 通常の `auto/3` (PID) と同じ動作。
- **target は静的**: `currentTargetPitch()` は phase==WT のとき `target[1]` (ユーザ値) を返す。climb_pitch / glide_pitch は使われない。
- **climb_ff = 0**: エレベータ feed-forward オフセット無し。
- **tilt safeguard 抑制**: 支柱固定で大角度になっても MANUAL に落ちない。
- **failsafe 抑制**: 測定中の離席を許容（地上局接続が落ちても PID 継続）。
- **launch 検出無効**: 高 G の入力があっても遷移しない（風洞では関係ない）。
- **着地検出無効**: 静置状態でも勝手に LANDED に遷移しない。

CSV ログには `phase=5` の列が記録されるので、応答プロット時に WT 区間を抽出できる。

## 投擲フローでの重要な振る舞い

- **armed 中 (DISARMED 以外) は failsafe 抑制** — 地上局接続が落ちても飛行/着陸まで継続。
- **LAUNCH 直後の launch_grace (既定 500ms) は PID ゼロホールド** — Madgwick が投擲ショックから復帰する猶予。この間も feed-forward（climb_ff）はエレベータに加算されるので機首上げ姿勢は維持される。`launch_grace <ms>` で調整可（0 で無効）。
- **LAUNCH 中のエレベータ feed-forward** — PID 出力に加えて `climb_ff`（既定 +5°）を加算し、機首上げを素早く実現。
- **tilt safeguard (`safe_angle`) は引き続き有効** — 極端な姿勢で MANUAL+trim=0 に強制復帰（落下防止）。
- **LANDED 検出** — `|az|<landed_g` が `landed_ms` 連続したら自動的にサーボ中立。地面で延々と PID が暴れない。
