import type { Metadata, Viewport } from "next";
import { TimelineProgressGuard } from "@/components/TimelineProgressGuard";
import "./globals.css";
import "./ui-polish.css";
import "./ui-fixes.css";
import "./ui-final-fixes.css";

export const metadata: Metadata = {
  title: "Shorts Studio — Universal Video Shorts Editor",
  description:
    "Turn long videos into platform-ready shorts through conversation. Browser-first, free-tier friendly.",
  manifest: "/manifest.webmanifest",
  applicationName: "Shorts Studio",
  appleWebApp: {
    capable: true,
    title: "Shorts Studio",
    statusBarStyle: "black-translucent"
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: "/icons/icon-192.png"
  }
};

export const viewport: Viewport = {
  themeColor: "#0b0d10",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <TimelineProgressGuard />
        {children}
        <script
          // Register the service worker. Failing silently is fine.
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').catch(function(){});
                });
              }
            `
          }}
        />
      </body>
    </html>
  );
}
