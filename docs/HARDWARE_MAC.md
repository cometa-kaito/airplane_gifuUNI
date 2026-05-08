# ハードウェア・MAC アドレス一覧

## ボード構成

| 役割 | ボード | MAC アドレス | 接続 | スケッチ |
|---|---|---|---|---|
| 機体制御 | XIAO nRF52840 Sense | （MAC は使わない） | サーボ D0/D1/D2、Serial1 D6/D7、USB | `glider_nRF52840.ino` |
| 機体側 無線中継 | XIAO ESP32-C3 #2 | `94:A9:90:6D:52:50` | nRF52840 と Serial1（D6/D7）、機体内に搭載 | `glider_ESP32C3_aircraft.ino` |
| 地上側 無線中継 | XIAO ESP32-C3 #1 | `58:8C:81:AE:E0:60` | PC に USB | `glider_ESP32C3_ground.ino` |

## peerMac の指定方向

ESP-NOW は**相手の MAC を指定する片方向アドレッシング**。各ボードには「相手」の MAC を入れる：

```
ground (#1) -----送信先指定-----> aircraft (#2)
   peerMac = 94:A9:90:6D:52:50
   コード: const uint8_t peerMac[6] = {0x94, 0xA9, 0x90, 0x6D, 0x52, 0x50};

aircraft (#2) -----送信先指定-----> ground (#1)
   peerMac = 58:8C:81:AE:E0:60
   コード: const uint8_t peerMac[6] = {0x58, 0x8C, 0x81, 0xAE, 0xE0, 0x60};
```

## サーボ配置（エルロン構成）

| ピン | コード上 | 役割 | 操作量との対応 | コマンド |
|---|---|---|---|---|
| **D0** | `servo[0]` | 右エルロン | `trim[0] + (+1) * u_roll` | `s0 <deg>` |
| **D1** | `servo[1]` | 左エルロン | `trim[1] + (-1) * u_roll`（左右逆位相） | `s1 <deg>` |
| **D2** | `servo[2]` | エレベータ | `trim[2] + u_pitch` | `s2 <deg>` |

- ラダー（yaw）は機体構成に含まないため、`Kp[2]/Ki[2]/Kd[2]` 既定値はゼロで yaw 出力は無効
- 物理取付の都合で左右の動作が逆になっていたら、`mixL <係数>` または `mixR <係数>` で調整可能
  - 例: `mixL 1.0` で左右同位相（フラッペロン的）
  - 例: `mixR -1.0 mixL 1.0` で位相反転

## ボードを買い直した／取り違えたとき

`Lesson11/Lesson11.ino` をどちらか一方の ESP32-C3 に書き込んでシリアルモニタに `/mac` と送ると、自機の MAC が表示される。それを上の表とコード（`peerMac`）の両方に反映する。
