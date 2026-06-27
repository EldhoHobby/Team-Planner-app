"use client";

import { useEffect } from "react";

/**
 * Applies the user's server-saved theme on load and mirrors it into
 * localStorage, so the pre-paint script in the root layout picks it up instantly
 * on subsequent loads. This is what makes the per-account theme follow the user
 * across browsers / devices / hostnames.
 */
export function ThemeSync({ theme }: { theme: string | null }) {
  useEffect(() => {
    if (theme !== "dark" && theme !== "light") return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return null;
}
