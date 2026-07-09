"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "rish-theme";

type ThemePreference = "system" | "light" | "dark";
type EffectiveTheme = "light" | "dark";

function storedPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function effectiveTheme(preference: ThemePreference, prefersDark: boolean): EffectiveTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

function nextPreference(
  preference: ThemePreference,
  effective: EffectiveTheme,
): ThemePreference {
  if (preference === "system") return effective === "dark" ? "light" : "dark";
  if (preference === "light") return "dark";
  return "system";
}

function applyPreference(preference: ThemePreference) {
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Some in-app browsers block localStorage; theme just won't persist.
    }
    return;
  }

  document.documentElement.setAttribute("data-theme", preference);
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Some in-app browsers block localStorage; theme just won't persist.
  }
}

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference | null>(null);
  const [prefersDark, setPrefersDark] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemPreference = () => setPrefersDark(query.matches);

    setPreference(storedPreference());
    syncSystemPreference();
    query.addEventListener("change", syncSystemPreference);
    return () => query.removeEventListener("change", syncSystemPreference);
  }, []);

  const mode = preference ?? "system";
  const effective = effectiveTheme(mode, prefersDark);
  const next = nextPreference(mode, effective);
  const label = `Theme: ${mode === "system" ? `browser (${effective})` : mode}. Switch to ${
    next === "system" ? "browser theme" : `${next} theme`
  }`;

  function toggle() {
    applyPreference(next);
    setPreference(next);
  }

  const Icon = mode === "system" ? Monitor : effective === "light" ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="grid size-10 place-items-center rounded-full text-muted transition-colors hover:text-accent"
    >
      <Icon strokeWidth={1.65} className="size-5" />
    </button>
  );
}
