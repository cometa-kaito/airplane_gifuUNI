"use client";

/**
 * StepNav — ヘッダ直下に sticky 表示する、Pre-flight Workflow への横並びジャンプナビ。
 *
 * ページが縦に長いため、各 Step（および Firmware）へ素早く移動できるように。
 * 接続状態に依らず常時表示。狭幅では横スクロール（whitespace-nowrap + overflow-x-auto）。
 * クリックで該当セクションへスムーズスクロール（各セクションには scroll-mt-* で
 * sticky ヘッダ + 本ナビ分のオフセットを付与してある）。
 */

type NavItem = {
  id: string;
  label: string;
};

const ITEMS: NavItem[] = [
  { id: "step-trim", label: "⓪ Trim" },
  { id: "step-cal", label: "較正" },
  { id: "step-calib", label: "① Calib" },
  { id: "step-safety", label: "② Safety" },
  { id: "step-manual", label: "③ Manual" },
  { id: "step-pid", label: "④ PID" },
  { id: "step-launch", label: "⑤ Launch" },
  { id: "step-windtunnel", label: "風洞" },
  { id: "step-autotune", label: "AutoTune" },
  { id: "step-firmware", label: "Firmware" },
];

export function StepNav() {
  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    // details 内（風洞 / AutoTune）は閉じていると scrollIntoView が無効なので開く
    const host = el.closest("details");
    if (host && !host.open) host.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav
      aria-label="Pre-flight steps"
      className="sticky top-[68px] z-20 backdrop-blur-md bg-white/85 border-b border-slate-200/70"
    >
      <div className="max-w-[1600px] mx-auto px-4 md:px-8">
        <div className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap py-2 -mx-1 px-1
                        [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="hidden sm:inline text-[10px] uppercase tracking-[0.12em] font-semibold text-slate-400 pr-1 flex-none">
            Jump
          </span>
          {ITEMS.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => jump(it.id)}
              className="flex-none px-2.5 py-1 rounded-md text-xs font-medium text-slate-600
                         ring-1 ring-slate-200 bg-white hover:bg-slate-50 hover:text-slate-900
                         hover:ring-slate-300 transition-colors"
            >
              {it.label}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
