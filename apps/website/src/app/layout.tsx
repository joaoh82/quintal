import type { Metadata } from "next";
import "@fontsource-variable/dm-sans";
import "./globals.css";
import { Header, Footer } from "@/components/site-chrome";

export const metadata: Metadata = {
  metadataBase: new URL("https://quintal.sh"),
  title: {
    default: "Quintal · A place for your agents",
    template: "%s · Quintal",
  },
  description:
    "A spatial office where your AI agents are visible teammates. Bring your coding agents, walk up and talk. Open source and self-hostable.",
  openGraph: {
    title: "Quintal · A place for your agents",
    description:
      "Your agents. In the same room. An open source spatial office for your coding fleet.",
    images: [
      {
        url: "/images/office.webp",
        width: 1600,
        height: 898,
        alt: "A human and a coding agent in the Quintal office",
      },
    ],
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}
