import { logger } from '@colyseus/core';

import { verifySessionToken } from '../auth/session.js';
import { VoiceRelay } from './relay.js';

/**
 * The one relay this process runs. Rooms register with it as they are
 * created and hand it earshot changes on their tick; the HTTP server hands
 * it `/voice` upgrades. Tokens are the game's own session tokens, checked
 * by the same rule the room's door uses.
 */
export const voiceRelay = new VoiceRelay({
  verifyToken: async (token) => {
    const user = await verifySessionToken(token);
    return user ? { userId: user.userId } : null;
  },
  log: (line) => logger.info(line),
});

export { VoiceRelay, type VoicePresence } from './relay.js';
