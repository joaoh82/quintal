/**
 * Light, dark, or whatever the system says.
 *
 * The preference lives in this browser only — it is how this screen looks,
 * not a fact about the person — and defaults to following the system, so
 * somebody who never opens the setting gets the theme their computer
 * already uses. The office chrome (roster, chat) is dark by design and
 * ignores all of this; these pages are the ones that were only ever light.
 */
export const THEME_KEY = 'quintal.theme';

export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEMES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** What to actually draw, given the preference and what the system prefers. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/**
 * Applied before the first paint, from an inline script in the document
 * head, so a dark preference never flashes light. The same rule as
 * `resolveTheme`, written without imports because it runs before any.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_KEY)});var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference: ThemePreference): void {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = resolveTheme(preference, systemDark) === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {
    // A browser that refuses storage still gets the theme for this visit.
  }
  applyTheme(preference);
}
