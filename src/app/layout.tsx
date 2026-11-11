import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "PULSEGRID 2.0 — NSE F&O Intelligence",
  description:
    "Unified real-time intraday F&O market intelligence for Indian markets: price, volume, OI momentum, futures, premium momentum, structure, dynamic S/R and evidence-driven trade decisions.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0a0c10",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-txt antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
