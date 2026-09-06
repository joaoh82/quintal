'use client';

import { AVATAR_SIZE } from '@quintal/shared';
import { useRef, useState } from 'react';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';

/**
 * Choose a face.
 *
 * The picked image never leaves the browser as it was: it is drawn onto a
 * small square canvas and exported as a PNG, so what is uploaded is always
 * the same size and shape, and never carries the metadata a camera writes
 * into a photograph. The server checks the result is exactly that.
 */
export function AvatarPicker({
  avatar,
  pubkey,
  disabled,
}: {
  avatar: string;
  pubkey: string;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pick(file: File) {
    setBusy(true);
    setError('');
    try {
      const png = await toSquarePng(file, AVATAR_SIZE);
      const response = await fetch('/api/avatar', {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: png,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `could not save (${response.status})`);
      }
      window.location.reload();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not use that image.');
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError('');
    const response = await fetch('/api/avatar', { method: 'DELETE' });
    if (response.ok) window.location.reload();
    else {
      setError(`could not remove (${response.status})`);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <h2 className="text-sm font-medium">Avatar</h2>
      <div className="flex items-center gap-4">
        <Avatar avatar={avatar} pubkey={pubkey} size={64} className="rounded-md" />
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">
            {avatar
              ? 'Shown on your profile card and in the roster.'
              : 'Drawn from your key until you choose one — the same face for you everywhere.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void pick(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => input.current?.click()}
            >
              {busy ? 'Saving…' : avatar ? 'Change' : 'Choose an image'}
            </Button>
            {avatar ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || busy}
                onClick={() => void remove()}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The centre square of an image, at `size` pixels, as a PNG.
 *
 * Decoding in the browser is the re-encode: whatever the file was, what
 * comes out is pixels the browser drew, in a container it wrote.
 */
async function toSquarePng(file: File, size: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw images.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not encode the image.');
    return blob;
  } finally {
    bitmap.close();
  }
}
