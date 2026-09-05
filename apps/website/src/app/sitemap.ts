import type { MetadataRoute } from "next";
export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/docs/", "/docs/getting-started/"].map((path) => ({
    url: `https://quintal.sh${path}`,
    changeFrequency: "monthly",
    priority: path === "" ? 1 : 0.7,
  }));
}
export const dynamic = "force-static";
