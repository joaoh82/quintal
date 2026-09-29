import type { MDXComponents } from "mdx/types";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Headings carry an id so a page can link to its own sections. */
function slug(node: ReactNode): string | undefined {
  const text = typeof node === "string" ? node : Array.isArray(node)
    ? node.filter((part) => typeof part === "string").join("")
    : undefined;
  if (!text) return undefined;
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h2: ({ children, ...props }: ComponentPropsWithoutRef<"h2">) => (
      <h2 id={slug(children)} {...props}>
        {children}
      </h2>
    ),
    h3: ({ children, ...props }: ComponentPropsWithoutRef<"h3">) => (
      <h3 id={slug(children)} {...props}>
        {children}
      </h3>
    ),
    ...components,
  };
}
