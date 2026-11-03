'use client';

import { BODIES, type BodyId } from '@quintal/shared';

import { BODY_FRAME, BODY_ROW, bodyPath } from '@/game/constants';

/** Columns and rows of a body's sheet: see `BODY_FRAME`. */
const SHEET = { columns: 8, rows: 4 } as const;

/**
 * One character, standing and facing you: the first frame of its sheet, drawn
 * from the same file the office walks it around in, so what is chosen here is
 * what shows up there.
 */
export function CharacterSprite({ body, scale = 1 }: { body: BodyId; scale?: number }) {
  const width = BODY_FRAME.width * scale;
  const height = BODY_FRAME.height * scale;
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{
        width,
        height,
        backgroundImage: `url(${bodyPath(body)})`,
        backgroundSize: `${width * SHEET.columns}px ${height * SHEET.rows}px`,
        backgroundPosition: `0 ${-BODY_ROW.down * height}px`,
        imageRendering: 'pixelated',
      }}
    />
  );
}

function characterLabel(body: BodyId): string {
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}`;
}

const TILE =
  'border-input hover:bg-muted peer-checked:border-primary peer-checked:bg-muted peer-checked:ring-primary/40 peer-focus-visible:ring-ring/50 flex w-14 cursor-pointer flex-col items-center gap-1 rounded-md border px-1 pt-1.5 pb-1 peer-checked:ring-2 peer-focus-visible:ring-2';

/**
 * Every character there is, to choose one by looking at it. Radio buttons under
 * the tiles, so it posts with its form and answers to the keyboard.
 *
 * With `allowRandom` it opens on "Random", which posts nothing the action reads
 * as a body and so leaves the choice to `createAgent`. Without it, `current`
 * is the one already worn.
 */
export function CharacterPicker({
  current,
  allowRandom = false,
  disabled = false,
}: {
  current?: BodyId;
  allowRandom?: boolean;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex w-full flex-col gap-1" disabled={disabled}>
      <legend className="text-xs font-medium">Character</legend>
      <div className="flex flex-wrap gap-1.5 py-1">
        {allowRandom ? (
          <label>
            <input type="radio" name="spriteKey" value="" defaultChecked className="peer sr-only" />
            <span className={TILE}>
              <span aria-hidden className="text-muted-foreground flex h-12 items-center text-xl">
                ?
              </span>
              <span className="text-[11px]">Random</span>
            </span>
          </label>
        ) : null}
        {BODIES.map((body) => (
          <label key={body}>
            <input
              type="radio"
              name="spriteKey"
              value={body}
              defaultChecked={body === current}
              className="peer sr-only"
            />
            <span className={TILE}>
              <CharacterSprite body={body} />
              <span className="text-[11px]">{characterLabel(body)}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
