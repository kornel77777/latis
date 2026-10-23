import { useEffect } from "react";
import type { Accent, Appearance } from "@latis/shared";

// Applies appearance settings (§8.1, §8.11) to the root element as CSS variables and data attributes.

/** Accent choices per theme. Light-theme values are darkened to reach WCAG AA as text on light surfaces (§8.12). */
export const ACCENTS: Record<Accent, { label: string; dark: string; light: string; fgDark: string; fgLight: string }> = {
  aurora: { label: "Aurora", dark: "#5eead4", light: "#0b7a6e", fgDark: "#062621", fgLight: "#ffffff" },
  nova: { label: "Nova", dark: "#818cf8", light: "#4f46e5", fgDark: "#0b0d2a", fgLight: "#ffffff" },
  ember: { label: "Ember", dark: "#fb923c", light: "#c2410c", fgDark: "#2a1103", fgLight: "#ffffff" },
  bloom: { label: "Bloom", dark: "#f472b6", light: "#be185d", fgDark: "#2a0718", fgLight: "#ffffff" },
  moss: { label: "Moss", dark: "#4ade80", light: "#166534", fgDark: "#05230f", fgLight: "#ffffff" },
  mono: { label: "Mono", dark: "#e9ecef", light: "#11151a", fgDark: "#0a0c0f", fgLight: "#ffffff" },
};

export function useAppearance(a: Appearance | undefined, theme: "dark" | "light") {
  useEffect(() => {
    if (!a) return;
    const root = document.documentElement;
    const accent = ACCENTS[a.accent];
    root.style.setProperty("--accent", theme === "dark" ? accent.dark : accent.light);
    root.style.setProperty("--accent-fg", theme === "dark" ? accent.fgDark : accent.fgLight);
    root.style.setProperty("--chat-text", `${a.chatTextSize}px`);
    root.style.setProperty("--card-opacity", String(a.cardOpacity));
    root.dataset.density = a.density;
    root.dataset.cardStyle = a.cardStyle;
    root.dataset.reduceMotion = String(a.reduceMotion);
  }, [a, theme]);
}
