import type { ComponentProps } from 'react';

/**
 * A link that leaves the app.
 *
 * In a browser that means a new tab, never navigating the office away. In
 * the desktop app the webview refuses to leave the server's origin and
 * hands the URL to the system browser instead — see `links.rs` — so the
 * same markup does the right thing in both.
 */
export function ExternalLink({ children, ...props }: ComponentProps<'a'>) {
  return (
    <a target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}
