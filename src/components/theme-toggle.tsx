"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setThemeAction } from "@/app/(app)/theme-actions";

/**
 * Toggles the `dark` class on <html>, persists the choice in localStorage for
 * instant pre-paint on reload, AND saves it to the user's account so it follows
 * them across browsers/devices/hostnames.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
    // Persist to the account (fire-and-forget; localStorage already covers the UI).
    void setThemeAction(next ? "dark" : "light");
  };

  return (
    <Button variant="outline" size="sm" onClick={toggle} className="w-full" aria-label="Toggle light/dark theme">
      {dark ? <Sun className="mr-1.5 h-4 w-4" /> : <Moon className="mr-1.5 h-4 w-4" />}
      {dark ? "Light mode" : "Dark mode"}
    </Button>
  );
}
