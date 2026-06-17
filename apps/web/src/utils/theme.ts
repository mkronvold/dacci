export type ThemeName = "default" | "slate";

export type ThemeOption = {
  value: ThemeName;
  label: string;
  description: string;
};

export const defaultThemeName: ThemeName = "default";
const legacyThemeStorageKey = "dacci.ui.theme";
export const themeStorageKey = "dacci.ui.theme.v2";
const scopedThemeStorageKeyPrefix = `${themeStorageKey}.scoped`;

export const themeOptions: ThemeOption[] = [
  {
    value: "default",
    label: "Material light",
    description: "Matches the default Material for MkDocs light palette used by ProperDocs.",
  },
  {
    value: "slate",
    label: "Material slate",
    description: "Matches the slate Material for MkDocs dark palette used by ProperDocs.",
  },
];

export function isThemeName(value: unknown): value is ThemeName {
  return value === "default" || value === "slate";
}

function readLegacyThemeName(rawValue: string | null): ThemeName | null {
  if (
    rawValue === "blue" ||
    rawValue === "green" ||
    rawValue === "dark" ||
    rawValue === "earth" ||
    rawValue === "black-tan" ||
    rawValue === "tan-black"
  ) {
    return "slate";
  }

  return isThemeName(rawValue) ? rawValue : null;
}

function readSystemThemeName(): ThemeName {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return defaultThemeName;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "slate" : "default";
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

    return readLegacyThemeName(window.localStorage.getItem(legacyThemeStorageKey)) ?? readSystemThemeName();
  } catch (error) {
    console.warn("Failed to read saved theme from localStorage.", error);
    return readSystemThemeName();
  }
}

function buildScopedThemeStorageKey(scopeId: string): string {
  return `${scopedThemeStorageKeyPrefix}:${scopeId}`;
}

export function readPersistedScopedThemeName(scopeId: string): ThemeName | null {
  if (typeof window === "undefined") {
    return null;
  }

  const normalizedScopeId = scopeId.trim();
  if (!normalizedScopeId) {
    return null;
  }

  try {
    const persistedValue = window.localStorage.getItem(buildScopedThemeStorageKey(normalizedScopeId));
    return isThemeName(persistedValue) ? persistedValue : null;
  } catch (error) {
    console.warn("Failed to read saved scoped theme from localStorage.", error);
    return null;
  }
}

export function writePersistedThemeName(themeName: ThemeName, scopeId?: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (scopeId?.trim()) {
      window.localStorage.setItem(buildScopedThemeStorageKey(scopeId.trim()), themeName);
      return;
    }

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
  return isThemeName(documentThemeName) ? documentThemeName : readPersistedThemeName();
}
