'use client';

import { useEffect, useState } from 'react';

import {
  THEMES,
  applyTheme,
  readThemePreference,
  saveThemePreference,
  type ThemePreference,
} from '@/lib/theme';

const LABEL: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Three choices, one row. Renders as "system" until it has read the stored
 * preference, so the server and the first client paint agree.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [preference, setPreference] = useState<ThemePreference>('system');

  useEffect(() => {
    setPreference(readThemePreference());
  }, []);

  // While following the system, follow it live: a laptop switching to dark
  // at sunset should take these pages with it without a reload.
  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={`bg-muted inline-flex rounded-md p-0.5 ${compact ? 'text-[11px]' : 'text-xs'}`}
    >
      {THEMES.map((option) => {
        const active = option === preference;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              setPreference(option);
              saveThemePreference(option);
            }}
            className={`rounded-[5px] px-2.5 py-1 transition-colors ${
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {LABEL[option]}
          </button>
        );
      })}
    </div>
  );
}
