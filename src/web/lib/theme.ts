import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "dots2api-theme";
const THEME_COLOR: Readonly<Record<Theme, string>> = { dark: "#0e0c0a", light: "#f1ede5" };

function stored(): Theme {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" ? "light" : "dark";
  } catch {
    // Storage can be blocked; the default theme is dark.
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/** Theme is local presentation state, unrelated to authentication. */
export function useTheme(): readonly [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not persisting is acceptable when storage is unavailable.
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((current) => (current === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
