import { identiconDataUri } from '@quintal/shared';

import { objectUrl } from '@/lib/objects';

/**
 * Somebody's face, at a size.
 *
 * A chosen one is fetched by its object key through the serving route, so
 * whoever can see the roster can see it and nobody else can. Without one
 * the face is derived from the key — no request, no storage, and the same
 * face for the same person everywhere.
 */
export function Avatar({
  avatar,
  pubkey,
  size,
  className,
}: {
  /** The object key of a chosen face, or empty. */
  avatar: string;
  /** The key the fallback is derived from. */
  pubkey: string;
  size: number;
  className?: string;
}) {
  const src = avatar ? objectUrl(avatar) : identiconDataUri(pubkey || 'nobody', size);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a same-origin
    // route or a data URI; nothing for next/image to optimise.
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`shrink-0 rounded-sm ${className ?? ''}`}
      style={{ width: size, height: size, imageRendering: avatar ? 'auto' : 'pixelated' }}
    />
  );
}
