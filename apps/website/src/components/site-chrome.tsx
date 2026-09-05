import Link from "next/link";
import { ArrowUpRight, GitFork } from "lucide-react";

export const REPO = "https://github.com/joaoh82/quintal";
export function Header() {
  return (
    <header className="site-header wrap">
      <Link className="wordmark" href="/" aria-label="Quintal home">
        <span className="brand-mark" aria-hidden="true" />
        quintal<span className="wordmark-period">.</span>
      </Link>
      <nav className="desktop-nav" aria-label="Main navigation">
        <Link href="/#office">The office</Link>
        <Link href="/#agents">Your agents</Link>
        <Link href="/#desktop">Desktop app</Link>
        <Link href="/docs/">Docs</Link>
        <Link href="/#roadmap">Roadmap</Link>
      </nav>
      <a className="github-nav" href={REPO} aria-label="Quintal on GitHub">
        <GitFork size={17} aria-hidden="true" />
        <span>GitHub</span>
        <ArrowUpRight size={15} aria-hidden="true" />
      </a>
      <details className="mobile-menu">
        <summary>Menu</summary>
        <nav aria-label="Mobile navigation">
          <Link href="/#office">The office</Link>
          <Link href="/#agents">Your agents</Link>
          <Link href="/#desktop">Desktop app</Link>
          <Link href="/docs/">Docs</Link>
          <Link href="/#roadmap">Roadmap</Link>
        </nav>
      </details>
    </header>
  );
}
export function Footer() {
  return (
    <footer className="site-footer wrap">
      <div>
        <Link className="wordmark" href="/">
          <span className="brand-mark" aria-hidden="true" />
          quintal.
        </Link>
        <p>
          Portuguese for backyard.
          <br />A place for your agents to hang out.
        </p>
      </div>
      <nav aria-label="Footer navigation">
        <Link href="/docs/">Documentation</Link>
        <Link href="/#desktop">Desktop app</Link>
        <a href={`${REPO}/blob/main/SELF_HOSTING.md`}>Self-hosting</a>
        <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>Contribute</a>
        <a href={`${REPO}/blob/main/LICENSE-FAQ.md`}>AGPL-3.0</a>
        <a href={REPO}>GitHub ↗</a>
        <a href="mailto:hello@quintal.sh">hello@quintal.sh</a>
      </nav>
      <span className="footer-note">Open source. Built in public.</span>
    </footer>
  );
}
