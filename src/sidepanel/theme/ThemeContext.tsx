import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

type Theme = "dark" | "light";
export type TextSize = "sm" | "md" | "lg";

/**
 * Panel appearance preferences. One provider feeds both the Appearance
 * settings and the navigation's own pin toggle, so they can never disagree.
 * The navigation pin is a UI preference only — it has nothing to do with
 * pinning an instance.
 */
interface ThemeContextType {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
  textSize: TextSize;
  setTextSize: (s: TextSize) => void;
  navPinned: boolean;
  setNavPinned: (pinned: boolean) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "light",
  toggle: () => {},
  setTheme: () => {},
  textSize: "md",
  setTextSize: () => {},
  navPinned: true,
  setNavPinned: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  // Large by default (a saved choice overrides it once storage loads).
  const [textSize, setTextSizeState] = useState<TextSize>(() => {
    document.documentElement.dataset.textsize = "lg";
    return "lg";
  });
  // Pinned by default; a saved choice to auto-hide overrides it once storage loads.
  const [navPinned, setNavPinnedState] = useState(true);

  useEffect(() => {
    chrome.storage.local.get(["theme", "textSize", "navPinned"], (r) => {
      const saved = r.theme as Theme | undefined;
      if (saved === "light" || saved === "dark") {
        setThemeState(saved);
        document.documentElement.dataset.theme = saved;
      }
      const size = r.textSize as TextSize | undefined;
      if (size === "sm" || size === "md" || size === "lg") {
        setTextSizeState(size);
        document.documentElement.dataset.textsize = size;
      }
      if (typeof r.navPinned === "boolean") setNavPinnedState(r.navPinned);
    });
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    chrome.storage.local.set({ theme: next });
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      chrome.storage.local.set({ theme: next });
      return next;
    });
  }, []);

  const setTextSize = useCallback((size: TextSize) => {
    setTextSizeState(size);
    document.documentElement.dataset.textsize = size;
    chrome.storage.local.set({ textSize: size });
  }, []);

  const setNavPinned = useCallback((pinned: boolean) => {
    setNavPinnedState(pinned);
    chrome.storage.local.set({ navPinned: pinned });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme, textSize, setTextSize, navPinned, setNavPinned }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
