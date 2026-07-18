import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "SignalForge | Web research",
  description: "Source-attributed AI web research, made observable.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <header className="site-header">
          <a className="brand" href="/">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>SignalForge</span>
          </a>
          <span className="eyebrow">AI research workspace</span>
        </header>
        <main className="page-shell" id="main-content">
          {children}
        </main>
      </body>
    </html>
  );
}
