'use client';

import type { TeamRef } from '@quintal/shared';
import type { Element, ElementContent, Root } from 'hast';
import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { describeTeam, textOrTeams } from './links';

/**
 * What an agent said, as the Markdown it was written in.
 *
 * Agents answer in GitHub-flavoured Markdown — tables, lists, fenced code —
 * and shown as text that is a wall of pipes and backticks. This renders it,
 * and is careful about what it renders:
 *
 * - Raw HTML is never markup. react-markdown turns it back into the text it
 *   was, so `<script>` in a reply reads as `<script>`.
 * - Only `http(s)` addresses become links, the same rule the plain-text
 *   transcript keeps. They open away from the office: a new tab on the web,
 *   the system browser in the desktop app. Any other scheme — `javascript:`,
 *   `data:`, a relative path — is left as the words it was attached to.
 * - Images are never fetched. An image is a link to where it lives, named by
 *   its alt text, so reading a reply does not make a request on its behalf.
 * - An `@team` in prose is the chip the transcript always showed. In code it
 *   is what the code says, and stays text.
 *
 * Unclosed fences and half-written tables are fine: Markdown has an answer
 * for every prefix of a document, so a reply still streaming renders as far
 * as it has got.
 */
export const Markdown = memo(function Markdown({
  text,
  teams = [],
}: {
  text: string;
  teams?: readonly TeamRef[];
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[teamChips, teams]]}
      urlTransform={webOnly}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
});

/** `http(s)` stays; anything else loses its address and keeps its words. */
function webOnly(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

const LINK =
  'break-all text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200 hover:decoration-sky-200';

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <>{children}</>;
  // The click stays in the anchor so nothing behind the transcript (the
  // overlay's close-on-backdrop, the map) takes it as its own.
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={stop} className={LINK}>
      {children}
    </a>
  );
}

const components: Components = {
  p: ({ children }) => <p className="my-1 whitespace-pre-wrap break-words">{children}</p>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ src, alt }) => {
    const label = `image: ${alt || 'untitled'}`;
    return typeof src === 'string' && src ? <Link href={src}>[{label}]</Link> : <>[{label}]</>;
  },
  h1: ({ children }) => <p className="mb-1 mt-2 font-semibold text-white">{children}</p>,
  h2: ({ children }) => <p className="mb-1 mt-2 font-semibold text-white">{children}</p>,
  h3: ({ children }) => <p className="mb-1 mt-2 font-semibold text-white/95">{children}</p>,
  h4: ({ children }) => <p className="mb-1 mt-2 font-medium text-white/90">{children}</p>,
  h5: ({ children }) => <p className="mb-1 mt-2 font-medium text-white/90">{children}</p>,
  h6: ({ children }) => <p className="mb-1 mt-2 font-medium text-white/90">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="break-words [&>p]:my-0">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-white/20 pl-3 text-white/70">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-white/15" />,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  // Fenced code is a `code` inside a `pre`; the `pre` carries the block look,
  // so an inline `code` is only ever the small chip.
  pre: ({ children }) => (
    <pre className="my-1 max-h-80 overflow-auto rounded [color-scheme:dark] bg-black/30 p-2 font-mono text-[0.92em] leading-snug text-white/90 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-white/10 px-1 font-mono text-[0.92em] text-white/90">{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-1 max-w-full overflow-x-auto [color-scheme:dark]">
      <table className="border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className="border border-white/15 bg-white/5 px-2 py-0.5 font-semibold">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-white/15 px-2 py-0.5 align-top">
      {children}
    </td>
  ),
};

/** Elements whose text is not prose: an `@team` there is not a mention. */
const VERBATIM = new Set(['code', 'pre', 'a']);

/**
 * A rehype plugin: each `@team` in prose becomes the amber chip, titled with
 * who the team is. It runs on the tree Markdown produced, so it never sees
 * inside code, and a link's own words stay the link's.
 */
function teamChips(teams: readonly TeamRef[]) {
  const names = teams.map((team) => team.name);
  const visit = (parent: Root | Element): void => {
    if (parent.type === 'element' && VERBATIM.has(parent.tagName)) return;
    parent.children = parent.children.flatMap((child): ElementContent[] => {
      if (child.type === 'element') {
        visit(child);
        return [child];
      }
      if (child.type !== 'text') return child.type === 'doctype' ? [] : [child];
      return textOrTeams(child.value, names).map((segment): ElementContent =>
        segment.kind === 'team'
          ? {
              type: 'element',
              tagName: 'span',
              properties: {
                className: ['rounded', 'bg-amber-200/15', 'px-1', 'text-amber-200'],
                title: describeTeam(segment.name, teams),
              },
              children: [{ type: 'text', value: segment.text }],
            }
          : { type: 'text', value: segment.text },
      );
    });
  };
  return (tree: Root): void => {
    if (names.length > 0) visit(tree);
  };
}
