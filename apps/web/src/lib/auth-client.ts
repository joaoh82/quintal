import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Same-origin: the auth API is served by this app at `/api/auth`, in dev and in
 * the unified production process alike, so no baseURL is needed.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

export const { signIn, signOut, useSession } = authClient;
