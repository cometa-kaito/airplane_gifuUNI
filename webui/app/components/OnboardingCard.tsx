"use client";

/**
 * OnboardingCard — 未接続(OFFLINE)時に最上部へ出す導入カード。
 *
 * 公開版の初訪問者向け: これが何か / Chrome・Edge 専用 / 始め方3ステップ /
 * ファーム入手(GitHub) を一目で示し、接続できれば自動的に消える（ライブ表示に切替）。
 */

const REPO_URL = "https://github.com/cometa-kaito/airplane_gifuUNI";

const STEPS = [
  { n: 1, t: "つなぐ", d: "地上機 (ESP32-C3) を USB 接続し ▶ Connect Device。" },
  { n: 2, t: "（初回）書込み＆ペア", d: "ファームを GitHub から入手して書込み、/setpeer で機体とペアリング。" },
  { n: 3, t: "上から順に設定", d: "⓪サーボ較正→トリム→①キャリブ→②安全→③手動→④PID→⑤Launch。" },
];

export function OnboardingCard({
  onConnect,
  supported,
}: {
  onConnect: () => void;
  supported: boolean;
}) {
  return (
    <section className="rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 p-6 md:p-7">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="max-w-2xl">
          <h2 className="text-xl font-semibold text-slate-800 tracking-tight">
            自律滑空機テレメトリ — はじめ方
          </h2>
          <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
            ブラウザから USB の地上機を直接掴んで（WebSerial）、機体の姿勢監視・PID 調整・
            サーボ較正・自律飛行設定を行うツールです。<strong>Chrome / Edge 専用</strong>・
            サーバ不要・インストール不要。
          </p>
        </div>
        {!supported && (
          <span className="text-xs font-medium text-amber-700 bg-amber-50 ring-1 ring-amber-200 rounded-md px-2.5 py-1.5">
            ⚠ このブラウザは WebSerial 非対応。Chrome / Edge で開いてください
          </span>
        )}
      </div>

      <ol className="mt-4 grid gap-3 sm:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.n} className="rounded-xl bg-slate-50 ring-1 ring-slate-200/60 p-3.5">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">
                {s.n}
              </span>
              <span className="text-sm font-semibold text-slate-800">{s.t}</span>
            </div>
            <p className="text-xs text-slate-500 mt-1.5 leading-snug">{s.d}</p>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button
          onClick={onConnect}
          disabled={!supported}
          className="btn-primary disabled:opacity-40"
        >
          ▶ Connect Device
        </button>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-indigo-600 hover:text-indigo-700 underline"
        >
          ファーム入手・初回手順（GitHub）
        </a>
        <span className="text-xs text-slate-400">
          機体が無くても画面は閲覧できます（操作には USB 接続が必要）。
        </span>
      </div>
    </section>
  );
}
