import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

export type NextRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

interface NextApp {
  prepare(): Promise<void>;
  getRequestHandler(): NextRequestHandler;
}

/**
 * Boot the Next.js app inside this process and return its request handler.
 *
 * This is what makes Quintal a single deployable service: one Node process, one
 * port, same origin for the web app and the game socket. Next is imported
 * lazily so `pnpm dev` (game server only) never pays for it.
 */
export async function createNextHandler(
  webDir: string,
): Promise<NextRequestHandler> {
  const buildDir = resolve(webDir, '.next');
  if (!existsSync(buildDir)) {
    throw new Error(
      `No Next.js build found at ${buildDir}. Run "pnpm build" before "pnpm start".`,
    );
  }

  // `next`'s published types don't describe its default export as callable
  // (it is CJS `module.exports = createServer`), so type the factory locally.
  const { default: createNextApp } = (await import('next')) as unknown as {
    default: (options: { dev: boolean; dir: string }) => NextApp;
  };

  const app = createNextApp({ dev: false, dir: webDir });
  await app.prepare();
  return app.getRequestHandler();
}
