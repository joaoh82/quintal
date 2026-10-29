import type { Metadata } from "next";
import { REPO } from "@/components/site-chrome";
import { VERSION } from "@/lib/version";
import { RELEASES } from "./releases";

export const metadata: Metadata = {
  title: "Changelog",
  description: `What's new in Quintal, release by release. The current version is v${VERSION}.`,
};

function formatDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function Changelog() {
  // A release cut before its entry was written still shows up, pointing at GitHub's notes.
  const unlisted = RELEASES.some((release) => release.version === VERSION) ? null : VERSION;
  return (
    <main id="main" className="changelog-page wrap">
      <header className="changelog-intro">
        <h1>Changelog</h1>
        <p>
          What's new in Quintal, release by release. The current version is{" "}
          <strong>v{VERSION}</strong>. Every release has installers, checksums and the full commit list{" "}
          <a href={`${REPO}/releases`}>on GitHub</a>.
        </p>
      </header>
      <ol className="changelog-list">
        {unlisted ? (
          <li className="changelog-entry" id={`v${unlisted}`}>
            <div className="changelog-meta">
              <h2>v{unlisted}</h2>
              <span className="changelog-current">Current</span>
            </div>
            <p>
              <a href={`${REPO}/releases/tag/v${unlisted}`}>Read the release notes on GitHub.</a>
            </p>
          </li>
        ) : null}
        {RELEASES.map((release) => (
          <li className="changelog-entry" id={`v${release.version}`} key={release.version}>
            <div className="changelog-meta">
              <h2>
                <a href={`#v${release.version}`}>v{release.version}</a>
              </h2>
              {release.version === VERSION ? <span className="changelog-current">Current</span> : null}
              <time dateTime={release.date}>{formatDate(release.date)}</time>
            </div>
            <div className="changelog-body">
              <h3>{release.summary}</h3>
              <ul>
                {release.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              <a className="changelog-notes" href={`${REPO}/releases/tag/v${release.version}`}>
                Release notes and downloads ↗
              </a>
            </div>
          </li>
        ))}
      </ol>
    </main>
  );
}
