import type { OfficeMap, TileRect } from '@quintal/shared';

/** Keep the overview and local crop inside the office, including at corners. */
export function minimapBounds(
  map: Pick<OfficeMap, 'width' | 'height'>,
  viewport: TileRect,
  self?: { x: number; y: number },
): TileRect {
  const width = Math.min(map.width, Math.max(24, viewport.width * 2));
  const height = Math.min(map.height, width * map.height / map.width);
  const x = (self?.x ?? viewport.x + viewport.width / 2) - width / 2;
  const y = (self?.y ?? viewport.y + viewport.height / 2) - height / 2;
  return {
    x: Math.max(0, Math.min(map.width - width, x)),
    y: Math.max(0, Math.min(map.height - height, y)),
    width,
    height,
  };
}

/** One SVG path instead of a React element for every blocked tile. */
export function minimapObstacles(map: Pick<OfficeMap, 'width' | 'height' | 'walkable'>): string {
  const rows: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let x = 0;
    while (x < map.width) {
      if (map.walkable[y * map.width + x]) { x++; continue; }
      const start = x;
      while (x < map.width && !map.walkable[y * map.width + x]) x++;
      rows.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  }
  return rows.join('');
}
