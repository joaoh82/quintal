/**
 * Who may read which object.
 *
 * An unguessable key is not access control, so every object has a policy,
 * and the policy is read off the key's namespace — the first segment — so
 * the store itself never has to know what an avatar is.
 *
 * Two namespaces so far. `avatars/` is office-public: anyone signed in,
 * guests included, may see a face, because that is what a face is for.
 * `uploads/<user>/` is what somebody put here and nobody else has been
 * shown yet; only they may read it back. Attachments will bring a third,
 * scoped to a conversation, when they exist.
 */
export interface ObjectReader {
  user: { id: string };
  session: { isGuest: boolean };
}

export function mayReadObject(reader: ObjectReader, key: string): boolean {
  const [namespace, owner] = key.split('/');
  switch (namespace) {
    case 'avatars':
      return true;
    case 'uploads':
      return !reader.session.isGuest && owner === reader.user.id;
    default:
      return false;
  }
}

/** Where somebody's own uploads go. The user id is a namespace, not a secret. */
export function uploadKeyFor(userId: string, id: string, extension: string): string {
  return `uploads/${userId}/${id}.${extension}`;
}

/** The URL the app serves an object at. */
export function objectUrl(key: string): string {
  return `/api/objects/${key}`;
}

/**
 * The body, or null once it has exceeded `max` — reading stops there.
 *
 * A `Content-Length` is a claim, and a missing one is normal. Reading the
 * whole body and then weighing it would mean an upload door that buffers
 * whatever it is sent; this refuses at the byte after the cap instead.
 */
export async function readBounded(request: Request, max: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
