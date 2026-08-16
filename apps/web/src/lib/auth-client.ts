import { createAuthClient } from 'better-auth/react';

/**
 * Same-origin: the auth API is served by this app at `/api/auth`, in dev and in
 * the unified production process alike, so no baseURL is needed.
 *
 * Sign-in itself does not go through this client — the challenge/verify pair
 * lives in `lib/keys.ts`, next to the key handling it depends on. What is left
 * here is everything after you are already signed in.
 */
export const authClient = createAuthClient();

export const { signOut, useSession } = authClient;
