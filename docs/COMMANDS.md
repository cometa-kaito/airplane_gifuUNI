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
| `ping` | ハートビート。応答を返さず `lastUplinkMs` だけ更新する。WebUI が ~750ms 毎に自動送信し `failsafe` 発火を防ぐ |
| `failsafe <ms>` | アップリンク途絶でフェイルセーフ発動するまでの ms を設定（既定 1500、`0` で無効） |
| `safe_angle <deg>` | 姿勢角しきい値（`|roll|` または `|pitch|` がこれを超えると AUTO→MANUAL に強制復帰）。既定 60、`0` で無効、**`>=180` も無効 (Madgwick の境界誤動作を避けるため)** |
| `tilt_limit <deg>` | `safe_angle` のエイリアス |
| `dfilter <alpha>` | D 項に掛ける 1次 IIR LPF 係数 (0..0.99)。**既定 0.85** (30Hz サンプリングで cutoff ~0.84Hz)。**0 で生 D**、大きいほど滑らかになる代わりに応答が遅延。サーボの「ぴくぴく」抑制に使用 |
| `zero` | **取付角キャリブレーション**: 今の Madgwick 出力 (roll/pitch/yaw) を「0°」基準として記録。以降の PID / safeguard / テレメトリ はこの基準からの相対角になる。RAM 保持 (再起動でクリア)。フライト前に機体を水平に置いて実行 |
| `unzero` | `zero` で設定したオフセットを解除して生 IMU 出力に戻す |
| `arm` | **投擲検知の有効化** (自律滑空モード)。MANUAL ホールドのまま `|a|>launch_g` の連続検出を待ち、検知すると AUTO/PID へ自動遷移。Arm 中は failsafe が抑制される |
| `disarm` | armed 状態を解除（地上テスト用） |
| `launch_g <g>` | 投擲判定の加速度しきい値 [g]。既定 2.5、範囲 1.0..8.0 |

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

WebUI は接続中 **約 750ms 毎に `ping` を自動送信** することで、ユーザーが UI に触っていなくても uplink を生存させ、不要な failsafe 発火を防いでいる。`failsafe 0` で完全に無効化することもできるが、本当に uplink が落ちた時のセーフティが効かなくなる点に注意。Python ground_station 経由で WebUI から `ping` を送る場合は **「Accept WS commands」を ON** にしておく必要がある。

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

```
seq, t_ms, dt_ms, ax, ay, az, gx, gy, gz, roll, pitch, yaw, s0, s1, s2
```

例：
```
1234,567890,20,0.012,0.034,0.998,0.10,-0.20,0.00,1.23,-0.50,0.00,90,92,88
```

50Hz（20ms 周期）で配信。`viewer_serialsend.py` 互換。

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

## 投擲検知（自律滑空フロー）

地上局から逐一 AUTO 操作する必要を無くす自律飛行モード。
WebUI の Step 1〜4 で事前準備を済ませた後、最後に `arm` を送って投擲する。

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

# 4. PID ゲインを設定
kp r 1.0
kp p 1.0
kd r 0.02
kd p 0.02

# 5. 投擲検知を有効化、しきい値設定
launch_g 2.5
arm                 ← MANUAL ホールドで待機
                    # → [ARM] ARMED (waiting throw >2.5g). Failsafe suppressed while armed.

# 6. 機体を投擲する
                    # → [LAUNCH] detected |a|=3.20g -> AUTO/PID (grace 500ms)
                    # 500ms grace → PID 制御開始 → 自律滑空

# 7. 回収後
disarm              ← 武装解除
```

**重要な振る舞い**:
- Arm 中は地上局接続が無くても飛行を継続できる（failsafe 抑制）。
- launched 直後の 500ms は PID 出力をゼロホールド（Madgwick が投擲ショックから復帰する猶予）。
- tilt safeguard (`safe_angle`) は引き続き有効。極端な姿勢で MANUAL+trim=0 に強制復帰する（落下防止）。
