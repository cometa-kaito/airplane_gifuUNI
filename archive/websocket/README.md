# archive/websocket — WebSocket 経路（退避）

WebUI を **WebSerial 専用**にしたため、WebSocket（Python `ground_station.py` 経由）の
プログラム一式をここへ退避しました。動作には使われませんが、将来「1 台の地上局を
複数端末で共有/閲覧」したい場合の参照用に保持しています。

## 中身

| ファイル | 元の場所 | 役割 |
|---|---|---|
| `ground_station.py` | `python_viewer/ground_station.py` | PC のシリアル ⇄ WebSocket サーバ（`ws://0.0.0.0:8765`）。CSV を JSON テレメトリに変換して配信し、WS からのコマンドを機体へ送る。 |
| `useTelemetry_ws.ts` | `webui/app/hooks/useTelemetry.ts`（の WS フック部分） | WebSocket に接続してテレメトリを受信する React フック `useTelemetry(url, token)`。再接続バックオフ付き。 |
| `ModeSelector.tsx` | `webui/app/components/ModeSelector.tsx` | 「WebSocket / WebSerial」切替タブ UI。 |

※ `webui/app/hooks/useTelemetry.ts` は現在も残っていますが、**共有の型/定数
（`TelemetryFrame` / `Status` / `PHASE_NAMES`）のみ**を提供するモジュールに縮小済みです
（約 20 コンポーネントが import しているためファイル名は据え置き）。

## 復元したい場合（概要）

1. `useTelemetry_ws.ts` の `useTelemetry` フックを `webui/app/hooks/useTelemetry.ts` に戻す
   （型定義と重複しないよう統合）。
2. `ModeSelector.tsx` を `webui/app/components/` に戻す。
3. `webui/app/page.tsx` に `mode`/`ModeSelector`/`useTelemetry` の分岐を復活させ、
   `NEXT_PUBLIC_WS_URL` / `NEXT_PUBLIC_WS_TOKEN` を再導入する。
4. `ground_station.py` を `python_viewer/` に戻して `pip install -r requirements.txt` 後に起動。

> ⚠ 公開（HTTPS）配信下では、ブラウザは `ws://`（非セキュア）へ接続できません
> （mixed content でブロック）。公開で WS を使うなら `wss://`（TLS）＋到達可能な
> 地上局が必要です。LAN 内・ローカルなら `ws://` で動きます。
