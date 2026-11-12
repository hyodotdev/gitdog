import { signal, effect } from "@preact/signals-react";

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "gitdog_theme";

const getStoredTheme = (): Theme | null => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
};

const getInitialTheme = (): Theme => {
  const stored = getStoredTheme();
  if (stored) {
    return stored as Theme;
  }

  // Check system preference
  if (
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
};

export const themeSignal = signal<Theme>(getInitialTheme());

// Apply theme to document
effect(() => {
  const theme = themeSignal.value;

  if (theme === "dark") {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
  } else {
    document.documentElement.classList.add("light");
    document.documentElement.classList.remove("dark");
  }

  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0a0a0a" : "#ffffff");
});

// Listen to system theme changes
if (window.matchMedia) {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", (e) => {
    // Only update if user hasn't manually set a preference
    if (!getStoredTheme()) {
      themeSignal.value = e.matches ? "dark" : "light";
    }
  });
}

export const toggleTheme = () => {
  themeSignal.value = themeSignal.value === "light" ? "dark" : "light";
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeSignal.value);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
};
