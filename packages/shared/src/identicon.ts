import { sha256 } from '@noble/hashes/sha2.js';

/**
 * A face for an identity that has not chosen one.
 *
 * Derived from the public key, so it costs no storage, cannot be spoofed —
 * the same key always draws the same face, and two keys draw different
 * ones — and gives an unnamed identity something to be recognised by in a
 * roster. A five-by-five grid, mirrored left to right so it reads as a
 * shape rather than noise, in a hue the key picks.
 */
export const IDENTICON_CELLS = 5;

/**
 * The side of a square avatar, in pixels. Defined here, where a browser
 * bundle can reach it, and re-exported by the server-only storage module.
 */
export const AVATAR_SIZE = 128;

export function identiconSvg(seed: string, size = 128): string {
  const hash = sha256(new TextEncoder().encode(seed));
  const hue = (((hash[0] ?? 0) << 8) | (hash[1] ?? 0)) % 360;
  const fill = `hsl(${hue} 55% 45%)`;
  const back = `hsl(${hue} 35% 92%)`;

  // Fifteen bits decide the left three columns of five rows; the right two
  // columns mirror the left. Bits are read from the hash after the hue.
  const cells: string[] = [];
  for (let row = 0; row < IDENTICON_CELLS; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const bit = row * 3 + col;
      const on = ((hash[2 + (bit >> 3)] ?? 0) >> (bit & 7)) & 1;
      if (!on) continue;
      cells.push(`<rect x="${col + 1}" y="${row + 1}" width="1" height="1"/>`);
      const mirror = IDENTICON_CELLS - 1 - col;
      if (mirror !== col) cells.push(`<rect x="${mirror + 1}" y="${row + 1}" width="1" height="1"/>`);
    }
  }

  const span = IDENTICON_CELLS + 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${size}" height="${size}" shape-rendering="crispEdges">` +
    `<rect width="${span}" height="${span}" fill="${back}"/>` +
    `<g fill="${fill}">${cells.join('')}</g>` +
    `</svg>`
  );
}

/** The same face as something an `<img>` can show without a request. */
export function identiconDataUri(seed: string, size = 128): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(identiconSvg(seed, size))}`;
}
