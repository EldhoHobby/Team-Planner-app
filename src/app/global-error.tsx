"use client";

// Last-resort error screen: replaces the ROOT layout when it fails, so it must
// render its own <html>/<body> and can't rely on the app's stylesheet or theme
// script having loaded. Styled with inline styles (always present) plus a tiny
// inline <style> for dark mode; no app components. Raw error text only in development.

import { useEffect } from "react";

const css = `
  .tp-ge { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
           background: #ffffff; color: #0f172a; margin: 0; min-height: 100vh; display: flex;
           align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  .tp-ge-card { max-width: 440px; width: 100%; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px;
                background: #ffffff; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .tp-ge-muted { color: #64748b; }
  .tp-ge-btn { display: inline-block; font: inherit; font-size: 14px; font-weight: 500; border-radius: 6px;
               padding: 8px 16px; cursor: pointer; text-decoration: none; border: 1px solid #0f172a;
               background: #0f172a; color: #f8fafc; }
  .tp-ge-btn.outline { background: transparent; color: inherit; border-color: #cbd5e1; }
  @media (prefers-color-scheme: dark) {
    .tp-ge, .tp-ge-card { background: #020817; color: #f8fafc; }
    .tp-ge-card { border-color: #1e293b; }
    .tp-ge-muted { color: #94a3b8; }
    .tp-ge-btn { background: #f8fafc; color: #0f172a; border-color: #f8fafc; }
    .tp-ge-btn.outline { background: transparent; color: #f8fafc; border-color: #334155; }
  }
`;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <title>Team Planner — error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body className="tp-ge">
        <main role="alert" className="tp-ge-card">
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>Team Planner is having trouble</h1>
          <p className="tp-ge-muted" style={{ fontSize: 14, lineHeight: 1.5, margin: 0 }}>
            The app couldn&apos;t load. The server may be restarting or unable to reach its database. Wait a moment and
            try again; if it keeps happening, tell your administrator.
          </p>
          {error.digest ? (
            <p className="tp-ge-muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              Reference: <span style={{ fontFamily: "ui-monospace, Consolas, monospace" }}>{error.digest}</span>
            </p>
          ) : null}
          {process.env.NODE_ENV === "development" && error.message ? (
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", margin: "12px 0 0", maxHeight: 160, overflow: "auto" }}>
              {error.message}
            </pre>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
            <button type="button" className="tp-ge-btn" onClick={() => reset()}>
              Try again
            </button>
            {/* Full page load: the client router may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate hard reload, not <Link> */}
            <a className="tp-ge-btn outline" href="/">
              Reload the app
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
