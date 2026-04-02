export type ThemeName = "blue" | "green" | "dark" | "earth" | "black-tan" | "tan-black";

export type ThemeOption = {
  value: ThemeName;
  label: string;
  description: string;
};

export const defaultThemeName: ThemeName = "blue";
const legacyThemeStorageKey = "dacci.ui.theme";
export const themeStorageKey = "dacci.ui.theme.v2";

export const themeOptions: ThemeOption[] = [
  {
    value: "blue",
    label: "Blue",
    description: "The current blue/slate Dacci palette.",
  },
  {
    value: "green",
    label: "Green",
    description: "A forest-green variant with similar darkness and contrast to blue.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "A cooler neutral dark theme with lower chroma.",
  },
  {
    value: "earth",
    label: "Earth",
    description: "A warm deep-grey palette with clay and tan accents.",
  },
  {
    value: "black-tan",
    label: "Black and tan",
    description: "A high-contrast theme with near-black panels and a tan backdrop.",
  },
  {
    value: "tan-black",
    label: "Tan and black",
    description: "An inverted black-and-tan palette with ink-dark backgrounds and tan panels.",
  },
];

export function isThemeName(value: unknown): value is ThemeName {
  return (
    value === "blue" ||
    value === "green" ||
    value === "dark" ||
    value === "earth" ||
    value === "black-tan" ||
    value === "tan-black"
  );
}

function readLegacyThemeName(rawValue: string | null): ThemeName | null {
  if (rawValue === "black-tan") {
    return "earth";
  }

  return isThemeName(rawValue) ? rawValue : null;
}

export function readPersistedThemeName(): ThemeName {
  if (typeof window === "undefined") {
    return defaultThemeName;
  }

  try {
    const persistedValue = window.localStorage.getItem(themeStorageKey);
    if (isThemeName(persistedValue)) {
      return persistedValue;
    }

    return readLegacyThemeName(window.localStorage.getItem(legacyThemeStorageKey)) ?? defaultThemeName;
  } catch (error) {
    console.warn("Failed to read saved theme from localStorage.", error);
    return defaultThemeName;
  }
}

export function writePersistedThemeName(themeName: ThemeName): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(themeStorageKey, themeName);
    window.localStorage.removeItem(legacyThemeStorageKey);
  } catch (error) {
    console.warn("Failed to save theme to localStorage.", error);
  }
}

export function applyThemeName(themeName: ThemeName): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = themeName;
}

export function readActiveThemeName(): ThemeName {
  if (typeof document === "undefined") {
    return defaultThemeName;
  }

  const shellThemeName = document.querySelector<HTMLElement>(".app-shell")?.dataset.theme;
  if (isThemeName(shellThemeName)) {
    return shellThemeName;
  }

  const documentThemeName = document.documentElement.dataset.theme;
  return isThemeName(documentThemeName) ? documentThemeName : defaultThemeName;
}
