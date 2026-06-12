import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MISSION CONTROL",
  description: "Personal assistant — live ops dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body className="bg-canvas font-mono antialiased min-h-screen">{children}</body>
    </html>
  );
}
