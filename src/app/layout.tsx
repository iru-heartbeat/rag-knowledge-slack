import type { ReactNode } from "react";

export const metadata = { title: "ナレッジ検索" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
