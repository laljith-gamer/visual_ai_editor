import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Universal Video Shorts Editor",
  description: "Prompt-driven video highlight editor",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
