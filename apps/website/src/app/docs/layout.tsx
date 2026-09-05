import Link from "next/link";
import { REPO } from "@/components/site-chrome";
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main id="main" className="docs-shell wrap">
      <nav className="docs-nav" aria-label="Documentation">
        <strong>The Quintal guide</strong>
        <Link href="/docs/">Overview</Link>
        <Link href="/docs/getting-started/">Getting started</Link>
        <a href={`${REPO}/blob/main/docs/guide/README.md`}>User guide ↗</a>
        <a href={`${REPO}/blob/main/SELF_HOSTING.md`}>Self-hosting ↗</a>
        <a href={`${REPO}/blob/main/docs/GATEWAY.md`}>Agent gateway ↗</a>
        <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>Contributing ↗</a>
      </nav>
      <article className="docs-content">{children}</article>
    </main>
  );
}
