import type { Metadata } from "next";
import type { ReactNode } from "react";
import "bootstrap/dist/css/bootstrap.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "COPYBOT // TERMINAL",
  description: "Polymarket copy-trading monitor"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-bs-theme="dark" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
