import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { THEME_BOOT_SCRIPT, THEME_KEY, isThemePreference, resolveTheme } from './theme.js';

/**
 * The one rule that matters: "system" follows the computer, and an explicit
 * choice does not. The boot script is the same rule with no imports, so it
 * is checked for the two things that would silently break it.
 */
describe('which theme to draw', () => {
  it('follows the system only when asked to', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('light', true), 'light');
  });

  it('treats anything unknown in storage as system', () => {
    assert.equal(isThemePreference('dark'), true);
    assert.equal(isThemePreference('blue'), false);
    assert.equal(isThemePreference(null), false);
  });

  it('boots from the same key, and never throws where storage is refused', () => {
    assert.ok(THEME_BOOT_SCRIPT.includes(JSON.stringify(THEME_KEY)));
    assert.ok(THEME_BOOT_SCRIPT.includes('prefers-color-scheme: dark'));
    assert.ok(THEME_BOOT_SCRIPT.startsWith('(function(){try{'), 'wrapped in a try');
  });
});
