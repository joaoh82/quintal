import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';

// Auth responses are per-request and must never be cached or prerendered.
export const dynamic = 'force-dynamic';

export const { GET, POST } = toNextJsHandler(auth.handler);
