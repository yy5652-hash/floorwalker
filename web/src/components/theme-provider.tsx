import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = Exclude<Theme, "system">;
const storageKey = "allowance-theme";
const isTheme = (value: unknown): value is Theme =>
  value === "light" || value === "dark" || value === "system";
function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(storageKey);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}
const media = window.matchMedia("(prefers-color-scheme: dark)");
function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? (media.matches ? "dark" : "light") : theme;
}
function applyTheme(theme: ResolvedTheme) {
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(theme);
  document.documentElement.style.colorScheme = theme;
}
// Runs from Vite's external module before React paints; no CSP-unsafe inline script.
applyTheme(resolveTheme(readTheme()));
const ThemeContext = createContext<{
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: string) => void;
} | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(theme),
  );
  useEffect(() => {
    const sync = () => {
      const resolved = resolveTheme(theme);
      applyTheme(resolved);
      setResolvedTheme(resolved);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [theme]);
  useEffect(() => {
    const syncStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null)
        setThemeState(readTheme());
    };
    window.addEventListener("storage", syncStorage);
    return () => window.removeEventListener("storage", syncStorage);
  }, []);
  function setTheme(next: string) {
    if (!isTheme(next)) return;
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* The in-memory preference still works when storage is unavailable. */
    }
    applyTheme(resolveTheme(next));
    setThemeState(next);
  }
  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
