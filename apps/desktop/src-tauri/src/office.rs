//! Which office this app is a window onto.
//!
//! Resolution order: `QUINTAL_OFFICE_URL`, then a file the settings screen will
//! write, then localhost. Kept apart from everything else because it decides
//! something security-relevant — see `capability_for` — and that decision
//! deserves to be readable on its own.

use std::path::{Path, PathBuf};

const OFFICE_FILE: &str = "office.txt";
const DEFAULT_OFFICE: &str = "http://localhost:3000";

/// Is this a URL we are willing to point a window at and grant IPC to?
///
/// The grant is built by interpolating this string into a capability, so a
/// value like `https://*` would become the pattern `https://*/*` and hand every
/// site on the internet the ability to ask this process for a signature.
/// Validated before it is ever used, not after.
pub fn is_usable_office(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };

    // A real host, and nothing a glob could hide in.
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.is_empty() || host.contains(['*', '?', '[', ']']) {
        return false;
    }

    match url.scheme() {
        "https" => true,
        // Cleartext only to this machine. `export_backup` hands back the blob
        // *and* its passphrase, which together are the nsec, so an office
        // reached over plain http is one anybody on the path can lift an
        // identity from. Loopback has no path to sit on.
        "http" => is_loopback(host),
        _ => false,
    }
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// The configured office URL, normalised to an origin with no trailing slash.
///
/// Anything unusable falls back to the default rather than being trusted: a
/// misconfigured office should land you on localhost, not on a wildcard.
pub fn office_url(dir: &Path) -> String {
    let raw = std::env::var("QUINTAL_OFFICE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::fs::read_to_string(office_path(dir))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_OFFICE.to_string());

    let trimmed = raw.trim_end_matches('/').to_string();
    if is_usable_office(&trimmed) {
        trimmed
    } else {
        eprintln!("[quintal] refusing office URL {trimmed:?}; using {DEFAULT_OFFICE}");
        DEFAULT_OFFICE.to_string()
    }
}

pub fn office_path(dir: &Path) -> PathBuf {
    dir.join(OFFICE_FILE)
}

/// The capability granting IPC to exactly one origin.
///
/// This is the answer to "who is allowed to ask this process for a signature".
/// Tauri grants remote pages access by URL pattern, and the tempting pattern —
/// `https://*` — would mean any site the window ever navigates to can call
/// `sign_challenge`. The office is a web app with links in it; one wrong click
/// and a stranger's page is talking to the keychain.
///
/// So the grant is built at startup from the configured office and nothing
/// else. Changing offices means restarting, which is the right price.
pub fn capability_for(office: &str) -> String {
    serde_json::json!({
        "identifier": "office-bridge",
        "description": "IPC for the configured office, and nothing else.",
        "windows": ["main"],
        // `local: false` so this grant applies only to the remote office, never
        // to the bundled bootstrap page.
        "local": false,
        // Both patterns: `navigate("https://office")` lands on a URL with no
        // path, which `{office}/*` alone does not match.
        "remote": { "urls": [office.to_string(), format!("{office}/*")] },
        "permissions": [
            "core:default",
            // Generated from `AppManifest::commands` in build.rs. Named one by
            // one rather than wildcarded: a command added later should have to
            // be granted deliberately, not inherit a blanket allow.
            "allow-has-identity",
            "allow-get-public-key",
            "allow-sign-challenge",
            "allow-import-identity",
            "allow-export-backup",
            "allow-confirm-backup",
            "allow-can-wipe",
            "allow-wipe-identity"
        ]
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_localhost() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(office_url(dir.path()), DEFAULT_OFFICE);
    }

    #[test]
    fn reads_a_configured_office_and_drops_the_trailing_slash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(office_path(dir.path()), "https://office.example.com/\n").unwrap();
        assert_eq!(office_url(dir.path()), "https://office.example.com");
    }

    #[test]
    fn refuses_office_urls_that_could_widen_the_grant() {
        assert!(is_usable_office("http://localhost:3000"));
        assert!(is_usable_office("http://127.0.0.1:3000"));
        assert!(is_usable_office("https://office.example.com"));

        // Cleartext off this machine. `export_backup` returns the blob and the
        // passphrase, which together are the key, so http to a remote office
        // hands the identity to anyone on the wire.
        assert!(!is_usable_office("http://office.example.com"));
        assert!(!is_usable_office("http://192.168.1.10:3000"));

        // The one that matters: a glob here becomes `https://*/*` in the
        // capability, which is every site on the internet.
        assert!(!is_usable_office("https://*"));
        assert!(!is_usable_office("https://*.example.com"));
        assert!(!is_usable_office("file:///etc/passwd"));
        assert!(!is_usable_office("javascript:alert(1)"));
        assert!(!is_usable_office("not a url"));
        assert!(!is_usable_office(""));
    }

    #[test]
    fn an_unusable_office_falls_back_rather_than_being_trusted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(office_path(dir.path()), "https://*").unwrap();
        assert_eq!(office_url(dir.path()), DEFAULT_OFFICE);
    }

    #[test]
    fn grants_the_commands_by_name_so_a_new_one_is_not_inherited() {
        let capability = capability_for("https://office.example.com");
        for permission in [
            "allow-sign-challenge",
            "allow-export-backup",
            "allow-wipe-identity",
        ] {
            assert!(
                capability.contains(permission),
                "{permission} must be granted"
            );
        }
        // The bootstrap page is local and must not get this grant.
        assert!(capability.contains("\"local\":false"));
    }

    #[test]
    fn grants_ipc_to_one_origin_and_no_wildcard() {
        let capability = capability_for("https://office.example.com");
        assert!(capability.contains("https://office.example.com/*"));
        // The whole point. A wildcard here would hand `sign_challenge` to any
        // page the window can reach.
        assert!(!capability.contains("https://*"));
        assert!(!capability.contains("http://*"));
    }
}
