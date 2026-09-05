import type { MetadataRoute } from "next";
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://quintal.sh/sitemap.xml",
  };
}
export const dynamic = "force-static";
