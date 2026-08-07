import { isWalkable, type OfficeMap } from '../map.js';

export interface TilePoint {
  x: number;
  y: number;
}

/**
 * A* over the walkability grid, four-directional (no diagonals — the avatar
 * only faces four ways, and cutting corners past a desk looks wrong).
 *
 * Returns the tiles to walk through, **excluding** the start and including the
 * goal. An empty array means there is no route, or you're already there.
 *
 * The map is small (40x30 = 1200 tiles), so a plain sorted-insert open list
 * beats a binary heap in practice and is much easier to read. If maps grow past
 * a few thousand tiles, swap in a heap.
 */
export function findPath(map: OfficeMap, start: TilePoint, goal: TilePoint): TilePoint[] {
  const startIndex = index(map, start);
  const goalIndex = index(map, goal);

  if (startIndex === goalIndex) return [];
  if (!isWalkable(map, goal.x, goal.y)) return [];
  if (!isWalkable(map, start.x, start.y)) return [];

  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>([[startIndex, 0]]);
  /** Open list kept sorted by fScore ascending; we always pop the head. */
  const open: Array<{ index: number; f: number }> = [
    { index: startIndex, f: manhattan(start, goal) },
  ];
  const closed = new Set<number>();

  while (open.length > 0) {
    const current = open.shift();
    if (!current) break;
    if (current.index === goalIndex) return reconstruct(map, cameFrom, goalIndex);
    if (closed.has(current.index)) continue;
    closed.add(current.index);

    const currentPoint = point(map, current.index);
    const currentG = gScore.get(current.index) ?? Number.POSITIVE_INFINITY;

    for (const neighbour of neighbours(currentPoint)) {
      if (!isWalkable(map, neighbour.x, neighbour.y)) continue;
      const neighbourIndex = index(map, neighbour);
      if (closed.has(neighbourIndex)) continue;

      const tentativeG = currentG + 1;
      if (tentativeG >= (gScore.get(neighbourIndex) ?? Number.POSITIVE_INFINITY)) continue;

      cameFrom.set(neighbourIndex, current.index);
      gScore.set(neighbourIndex, tentativeG);
      insertSorted(open, {
        index: neighbourIndex,
        f: tentativeG + manhattan(neighbour, goal),
      });
    }
  }

  return [];
}

/**
 * Nearest walkable tile to `target`, searched outward in rings. Lets a click on
 * a desk walk you to the near side of it instead of doing nothing.
 *
 * Within a ring, the closest by straight-line distance wins — scan order would
 * otherwise pick the top-left corner of the ring, which sends you around a wide
 * desk the long way.
 */
export function nearestWalkable(
  map: OfficeMap,
  target: TilePoint,
  maxRadius = 6,
): TilePoint | null {
  if (isWalkable(map, target.x, target.y)) return target;

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    let best: TilePoint | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        // Only the ring, not the filled square.
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const candidate = { x: target.x + dx, y: target.y + dy };
        if (!isWalkable(map, candidate.x, candidate.y)) continue;

        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
    }

    if (best) return best;
  }
  return null;
}

function neighbours({ x, y }: TilePoint): TilePoint[] {
  return [
    { x, y: y - 1 },
    { x: x + 1, y },
    { x, y: y + 1 },
    { x: x - 1, y },
  ];
}

function manhattan(a: TilePoint, b: TilePoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function index(map: OfficeMap, { x, y }: TilePoint): number {
  return y * map.width + x;
}

function point(map: OfficeMap, index: number): TilePoint {
  return { x: index % map.width, y: Math.floor(index / map.width) };
}

function insertSorted(open: Array<{ index: number; f: number }>, entry: { index: number; f: number }): void {
  let low = 0;
  let high = open.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((open[mid]?.f ?? Number.POSITIVE_INFINITY) < entry.f) low = mid + 1;
    else high = mid;
  }
  open.splice(low, 0, entry);
}

function reconstruct(
  map: OfficeMap,
  cameFrom: Map<number, number>,
  goalIndex: number,
): TilePoint[] {
  const path: TilePoint[] = [];
  let current: number | undefined = goalIndex;

  while (current !== undefined) {
    path.push(point(map, current));
    current = cameFrom.get(current);
  }

  path.pop(); // drop the start tile — we're standing on it
  return path.reverse();
}
