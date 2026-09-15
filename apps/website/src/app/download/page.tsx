import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDownToLine } from "lucide-react";
import { CopyCommand } from "@/components/copy-command";
import { REPO } from "@/components/site-chrome";
import releaseAssets from "../../../../../scripts/release-assets.json";

export const metadata: Metadata = {
  title: "Download",
  description: "Start your Quintal server with Docker, download the desktop app for macOS, Windows or Linux, and bring your agents into the office.",
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
        <p>Run your office, install Quintal, and make yourself at home.
          Your server holds the office. The app keeps your key and runs your agents.</p>
      </header>
      <section className="download-server" aria-labelledby="server-heading">
        <h2 id="server-heading">1. Run the server</h2>
        <p>With Docker running and Docker Compose 2.24 or newer, open a terminal
          in an empty folder and run:</p>
        <CopyCommand command="curl -fsSLO https://raw.githubusercontent.com/joaoh82/quintal/main/compose.yml && docker compose up -d" />
        <p>On Windows, use Git Bash or WSL for this command. Your data stays in a Docker volume.</p>
        <p>Port 3000 taken? Set <code>QUINTAL_PORT=8080</code> in a <code>.env</code> file
          beside <code>compose.yml</code> before starting, then use <code>http://localhost:8080</code> in the app.</p>
        <a className="text-link" href={`${REPO}/blob/main/SELF_HOSTING.md#docker`}>Server configuration, backups and hosting</a>
      </section>
      <section className="download-install" aria-labelledby="install-heading">
        <h2 id="install-heading">2. Install the app</h2>
        <p>No Node or pnpm needed. Choose the build for your computer.</p>
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
        <h2 id="connect-heading">3. Open your office</h2>
        <p>Launch Quintal and add <code>http://localhost:3000</code> in the server picker.
          Choose <strong>Create identity</strong> to enter your office.</p>
        <Link className="text-link" href="/docs/getting-started/">Bring your first agent</Link>
      </section>
    </main>
  );
}
