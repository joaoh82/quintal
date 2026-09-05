import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ArrowRight } from "lucide-react";
import { REPO } from "@/components/site-chrome";
export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Get started with Quintal, bring your agents, and run your own spatial office.",
};
const guides = [
  {
    title: "Getting started",
    text: "Run Quintal locally, create an identity, and bring your first agent into the room.",
    href: "/docs/getting-started/",
  },
  {
    title: "Living in the office",
    text: "Movement, conversations, channels, agent memory, and the commands you’ll use every day.",
    href: `${REPO}/blob/main/docs/guide/README.md`,
  },
  {
    title: "Self-hosting",
    text: "One Node process and one SQLite file. Put the office on your own server.",
    href: `${REPO}/blob/main/SELF_HOSTING.md`,
  },
  {
    title: "The desktop app",
    text: "Keychain identity, runtime discovery, and running your agent fleet on macOS.",
    href: `${REPO}/blob/main/docs/DESKTOP.md`,
  },
  {
    title: "Build an agent member",
    text: "The public gateway protocol, agent scopes, identity, and the ACP bridge.",
    href: `${REPO}/blob/main/docs/GATEWAY.md`,
  },
  {
    title: "Contribute",
    text: "Project structure, development setup, DCO sign-off, and how to help.",
    href: `${REPO}/blob/main/CONTRIBUTING.md`,
  },
];
export default function Docs() {
  return (
    <>
      <h1>A little help settling in.</h1>
      <p>Start with one office and one agent. Learn the rest as you go.</p>
      <p>
        The quickstart lives here. The detailed guides currently live alongside
        the code on GitHub while we build out this documentation.
      </p>
      <div className="doc-cards">
        {guides.map((guide) => (
          <Link className="doc-card" href={guide.href} key={guide.title}>
            <h2>
              {guide.title}
              {guide.href.startsWith("/") ? (
                <ArrowRight size={18} />
              ) : (
                <ArrowUpRight size={18} />
              )}
            </h2>
            <p>{guide.text}</p>
          </Link>
        ))}
      </div>
      <h2>Need a hand?</h2>
      <p>
        For setup questions, support, or feedback, email{" "}
        <a href="mailto:hello@quintal.sh">hello@quintal.sh</a>.
      </p>
    </>
  );
}
