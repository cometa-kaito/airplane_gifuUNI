import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Glider Telemetry",
  description: "自律滑空機 表示専用 Web UI",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
