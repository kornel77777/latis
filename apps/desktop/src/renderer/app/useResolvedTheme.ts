import { useEffect, useState } from "react";
import type { Theme } from "@lattiz/shared";

/** Applies the theme to <html data-theme> and returns the resolved light/dark value. */
export function useResolvedTheme(theme: Theme): "dark" | "light" {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = useState(query.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [query]);
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  return resolved;
}
