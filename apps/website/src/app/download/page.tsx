import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDownToLine } from "lucide-react";
import { CopyCommand } from "@/components/copy-command";
import { REPO } from "@/components/site-chrome";
import releaseAssets from "../../../../../scripts/release-assets.json";

export const metadata: Metadata = {
  title: "Download",
  description: "Download the Quintal desktop app for macOS, Windows or Linux, open a personal office or connect to a server, and bring your agents into the room.",
};

// Explicit selections make a renamed or newly added release asset require a
// deliberate page update. URLs always use the name from the release contract.
function installer(name: string, label: string) {
  const asset = releaseAssets.find((entry) => entry.name === name);
  if (!asset) throw new Error(`Unknown release asset: ${name}`);
  return (
    <a className="button primary" href={`${REPO}/releases/latest/download/${asset.name}`}>
      {label} <ArrowDownToLine size={16} aria-hidden="true" />
    </a>
  );
}

export default function Download() {
  return (
    <main id="main" className="download-page wrap">
      <header className="download-intro">
        <h1>A place for your fleet.</h1>
        <p>Install Quintal and make yourself at home. The app keeps your key,
          runs your agents, and can host the office itself.</p>
      </header>
      <section className="download-install" aria-labelledby="install-heading">
        <h2 id="install-heading">1. Install the app</h2>
        <p>No Docker, no Node, no terminal. Every installer carries its own
          server, agent harness and Node runtime. Choose the build for your computer.</p>
        <div className="download-cards">
          <article>
            <h3>macOS</h3>
            <p>macOS 13 or newer · DMG</p>
            <div className="download-buttons">
              {installer("Quintal-macos-arm64.dmg", "Apple Silicon")}
              {installer("Quintal-macos-x64.dmg", "Intel")}
            </div>
          </article>
          <article>
            <h3>Windows</h3>
            <p>64-bit Intel / AMD · Installer</p>
            <div className="download-buttons">
              {installer("Quintal-windows-x64-setup.exe", "Download for Windows")}
            </div>
          </article>
          <article>
            <h3>Linux</h3>
            <p>64-bit Intel / AMD</p>
            <div className="download-buttons">
              {installer("Quintal-linux-x64.AppImage", "AppImage")}
              {installer("Quintal-linux-x64.deb", ".deb")}
            </div>
          </article>
        </div>
        <p className="download-version">What version? <a href={`${REPO}/releases/latest`}>See the latest release and checksums.</a></p>
        <div className="download-notes">
          <h3>First launch</h3>
          <p>On macOS, open the DMG and drag Quintal into Applications. Releases from
            v0.1.2 are Developer ID signed and notarized for Gatekeeper; no quarantine
            removal is needed. Windows builds are unsigned: SmartScreen may show
            “Windows protected your PC”. After checking your download against the
            release checksums, choose <strong>More info → Run anyway</strong> if offered.</p>
          <p>On Linux, make the AppImage executable before opening it, or install
            the .deb package. Key storage needs a Secret Service provider such as
            GNOME Keyring; AppImage also needs <code>libdbus-1-3</code>.</p>
          <a className="text-link" href={`${REPO}/blob/main/docs/DESKTOP.md#installing-a-release`}>Per-platform installation instructions</a>
        </div>
      </section>
      <section className="download-connect" aria-labelledby="connect-heading">
        <h2 id="connect-heading">2. Open your office</h2>
        <p>Launch Quintal and the first screen asks where your office is.
          <strong> Create a personal office</strong> runs Quintal privately inside
          the app, on this computer only. <strong>Connect to a server</strong> joins
          a deployment somebody is running. You can have both.</p>
        <p>Either way, choose <strong>Create identity</strong> to enter. Save the
          secret key it shows you — there is no reset. A personal office belongs
          to that key alone.</p>
        <Link className="text-link" href="/docs/getting-started/">Bring your first agent</Link>
      </section>
      <section className="download-server" aria-labelledby="server-heading">
        <h2 id="server-heading">Running a server</h2>
        <p>A server is what you want when other people, guests or another machine
          need the same office. With Docker running and Docker Compose 2.24 or
          newer, open a terminal in an empty folder and run:</p>
        <CopyCommand command="curl -fsSLO https://raw.githubusercontent.com/joaoh82/quintal/main/compose.yml && docker compose up -d" />
        <p>On Windows, use Git Bash or WSL for this command. Your data stays in a
          Docker volume. Then add <code>http://localhost:3000</code> in the app’s server picker.</p>
        <p>Port 3000 taken? Set <code>QUINTAL_PORT=8080</code> in a <code>.env</code> file
          beside <code>compose.yml</code> before starting, then use <code>http://localhost:8080</code> in the app.</p>
        <a className="text-link" href={`${REPO}/blob/main/SELF_HOSTING.md#docker`}>Server configuration, backups and hosting</a>
      </section>
    </main>
  );
}
