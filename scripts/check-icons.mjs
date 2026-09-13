/**
 * Every committed icon is the size its name promises.
 *
 * The icon set is *generated* — `tauri icon` writes it once from
 * `apps/desktop/src-tauri/icons/source/app-icon.png` and the output is
 * committed, because `cargo build` reads those files rather than making them.
 * That is the right model (Buzz does the same), but it means the files are
 * checked-in binaries nobody diffs, and the failure mode is quiet: a
 * hand-resized `128x128.png` that is actually 64 wide still builds, still
 * bundles, and only shows up as a soft icon in somebody's Dock.
 *
 * So: read the PNG header of each one and compare it against the size its
 * filename or its role declares. A PNG's IHDR is the first chunk after the
 * 8-byte signature and its width and height are big-endian u32s at a fixed
 * offset — no decoder needed, which keeps this a dependency-free check that
 * can run before anything is installed.
 *
 *   node scripts/check-icons.mjs
 */
import { openSync, readSync, closeSync, existsSync } from 'node:fs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const desktop = 'apps/desktop/src-tauri/icons';
const web = 'apps/web/src/app';

/**
 * What each file must be, and why that number.
 *
 * `Square*Logo` sizes come straight out of their names; `StoreLogo` is the one
 * Windows asset whose name does not carry one, and 50 is what `tauri icon`
 * writes. The master is 1024 so every downscale below it is a downscale.
 */
const expected = [
  [`${desktop}/source/app-icon.png`, 1024, 'the master everything else is generated from'],
  [`${desktop}/32x32.png`, 32],
  [`${desktop}/64x64.png`, 64],
  [`${desktop}/128x128.png`, 128],
  [`${desktop}/128x128@2x.png`, 256, '@2x of 128'],
  [`${desktop}/icon.png`, 512, 'the Linux bundle icon'],
  [`${desktop}/StoreLogo.png`, 50],
  [`${desktop}/Square30x30Logo.png`, 30],
  [`${desktop}/Square44x44Logo.png`, 44],
  [`${desktop}/Square71x71Logo.png`, 71],
  [`${desktop}/Square89x89Logo.png`, 89],
  [`${desktop}/Square107x107Logo.png`, 107],
  [`${desktop}/Square142x142Logo.png`, 142],
  [`${desktop}/Square150x150Logo.png`, 150],
  [`${desktop}/Square284x284Logo.png`, 284],
  [`${desktop}/Square310x310Logo.png`, 310],
  [`${desktop}/tray.png`, 22, '22pt at 1x'],
  [`${desktop}/tray@2x.png`, 44, '22pt at 2x — the one the menu bar is handed'],
  [`${desktop}/tray-color.png`, 44, 'the Windows/Linux tray, which is not a template'],
  [`${web}/icon.png`, 64, "the office favicon, matching the website's"],
  [`${web}/apple-icon.png`, 180, 'the iOS home-screen tile'],
];

/** The two files that are not PNGs still have to exist; the bundle lists them. */
const alsoRequired = [`${desktop}/icon.icns`, `${desktop}/icon.ico`];

function dimensions(path) {
  const fd = openSync(path, 'r');
  try {
    // Signature (8) + length (4) + "IHDR" (4) + width (4) + height (4).
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) < 24) return { error: 'shorter than a PNG header' };
    if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) return { error: 'not a PNG' };
    if (head.subarray(12, 16).toString('latin1') !== 'IHDR') {
      return { error: 'first chunk is not IHDR' };
    }
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

const problems = [];

for (const [path, size, note] of expected) {
  const why = note ? ` (${note})` : '';
  if (!existsSync(path)) {
    problems.push(`${path}: missing${why}`);
    continue;
  }
  const { width, height, error } = dimensions(path);
  if (error) {
    problems.push(`${path}: ${error}`);
  } else if (width !== size || height !== size) {
    problems.push(`${path}: is ${width}x${height}, expected ${size}x${size}${why}`);
  }
}

for (const path of alsoRequired) {
  if (!existsSync(path)) problems.push(`${path}: missing`);
}

if (problems.length > 0) {
  console.error('Icons are not the sizes they claim to be:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nThe set is generated, not hand-edited. Redraw the master and rerun:\n' +
      '  pnpm --filter @quintal/desktop exec tauri icon src-tauri/icons/source/app-icon.png\n',
  );
  process.exit(1);
}

console.log(`Icons: ${expected.length} files at the sizes they claim, ${alsoRequired.length} present.`);
