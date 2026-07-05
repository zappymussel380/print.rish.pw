"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "rish-theme";

function currentTheme(): "dark" | "light" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light" | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function toggle() {
    const next = currentTheme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Some in-app browsers block localStorage; theme just won't persist.
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
      className="grid size-10 place-items-center rounded-full text-muted transition-colors hover:text-accent"
    >
      {/* Render both and swap via CSS so SSR markup is theme-agnostic. */}
      <Sun strokeWidth={1.65} className="size-5 hidden [html[data-theme='light']_&]:block" />
      <Moon strokeWidth={1.65} className="size-5 block [html[data-theme='light']_&]:hidden" />
    </button>
  );
}
