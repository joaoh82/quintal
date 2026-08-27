//! Which office this app is a window onto.
//!
//! Resolution order: `QUINTAL_OFFICE_URL`, then a file the settings screen will
//! write, then localhost. Kept apart from everything else because it decides
//! something security-relevant — see `capability_for` — and that decision
//! deserves to be readable on its own.

use std::path::{Path, PathBuf};
use std::time::Duration;

const OFFICE_FILE: &str = "office.txt";
const OFFICES_FILE: &str = "offices.json";
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
    let Some(host) = url.host() else {
        return false;
    };

    // Matched on the parser's own host type rather than on the string. A
    // string check has to reject `[` and `]` to keep globs out of the grant,
    // and that quietly refuses every IPv6 literal — `[::1]` is a bracketed
    // host, not a character class.
    let host_ok = match &host {
        url::Host::Domain(name) => !name.is_empty() && !name.contains(['*', '?', '[', ']']),
        url::Host::Ipv4(_) | url::Host::Ipv6(_) => true,
    };
    if !host_ok {
        return false;
    }

    match url.scheme() {
        "https" => true,
        // Cleartext only to this machine. `export_backup` hands back the blob
        // *and* its passphrase, which together are the nsec, so an office
        // reached over plain http is one anybody on the path can lift an
        // identity from. Loopback has no path to sit on.
        "http" => is_loopback(&host),
        _ => false,
    }
}

fn is_loopback(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(name) => *name == "localhost",
        // The whole 127.0.0.0/8 block, not just 127.0.0.1.
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    }
}

/// The configured office URL, normalised to an origin with no trailing slash.
///
/// Anything unusable falls back to the default rather than being trusted: a
/// misconfigured office should land you on localhost, not on a wildcard.
pub fn active_office_url(dir: &Path) -> Option<String> {
    if let Some(from_env) = std::env::var("QUINTAL_OFFICE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
    {
        return if is_usable_office(&from_env) {
            Some(from_env)
        } else {
            eprintln!("[quintal] refusing office URL {from_env:?} from the environment");
            None
        };
    }

    load_offices(dir)
        .active_office()
        .map(|office| office.url.clone())
}

/// The old single-office resolution, kept for callers that must have a URL.
#[allow(dead_code)]
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
pub fn capability_for(office: Option<&str>) -> String {
    // No office yet means a first run, and the only page there is the picker
    // this app ships. It still needs to call commands — that is how an office
    // gets added — so the capability exists with nothing remote in it.
    let remote: Vec<String> = match office {
        // Both patterns: `navigate("https://office")` lands on a URL with no
        // path, which `{office}/*` alone does not match.
        Some(office) => vec![office.to_string(), format!("{office}/*")],
        None => Vec::new(),
    };

    serde_json::json!({
        "identifier": "office-bridge",
        "description": "IPC for the configured office, and nothing else.",
        "windows": ["main"],
        // Local windows are included, and must be.
        //
        // In `tauri dev` the office *is* the dev server, and Tauri classifies
        // any URL relative to `devUrl` as local — so `local: false` refuses
        // every command in the exact configuration a developer runs:
        //
        //   has_identity not allowed on window "main", URL: local
        //
        // The only other local page is the bootstrap file this app ships,
        // which renders one paragraph and calls nothing. Excluding local buys
        // nothing and costs the whole development build.
        "remote": { "urls": remote },
        "permissions": [
            "core:default",
            // Generated from `AppManifest::commands` in build.rs. Named one by
            // one rather than wildcarded: a command added later should have to
            // be granted deliberately, not inherit a blanket allow.
            "allow-has-identity",
            "allow-detect-runtimes",
            "allow-get-public-key",
            "allow-sign-challenge",
            "allow-import-identity",
            "allow-export-backup",
            "allow-confirm-backup",
            "allow-can-wipe",
            "allow-wipe-identity",
            "allow-host-status",
            "allow-remember-host-token",
            "allow-forget-host-token",
            "allow-start-fleet",
            "allow-stop-fleet",
            "allow-fleet-status",
            "allow-fleet-logs",
            "allow-repos-dir",
            "allow-list-repos",
            "allow-pick-repos-dir",
            "allow-opens-at-login",
            "allow-set-opens-at-login",
            "allow-list-offices",
            "allow-add-office",
            "allow-switch-office",
            "allow-remove-office",
            "allow-open-office-picker"
        ]
    })
    .to_string()
}

#[cfg(test)]
mod offices_tests {
    use super::*;

    const A: &str = "https://a.example.com";
    const B: &str = "https://b.example.com";

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn a_first_run_has_no_offices_and_no_active_one() {
        let dir = dir();
        let offices = load_offices(dir.path());
        assert!(offices.offices.is_empty());
        assert_eq!(offices.active, None, "which is what the picker is for");
        assert_eq!(active_office_url(dir.path()), None);
    }

    #[test]
    fn the_first_office_added_becomes_the_active_one() {
        let dir = dir();
        add_office(dir.path(), A, None).expect("added");
        assert_eq!(active_office_url(dir.path()).as_deref(), Some(A));

        // ...and the second does not steal it.
        add_office(dir.path(), B, None).expect("added");
        assert_eq!(active_office_url(dir.path()).as_deref(), Some(A));
    }

    #[test]
    fn the_same_office_twice_is_one_office() {
        let dir = dir();
        add_office(dir.path(), A, None).expect("added");
        // Trailing slash and whitespace are the same address, and two entries
        // would mean two machine registrations for one place.
        add_office(dir.path(), &format!("  {A}/  "), None).expect("added again");
        assert_eq!(load_offices(dir.path()).offices.len(), 1);
    }

    #[test]
    fn an_office_this_app_will_not_connect_to_is_refused() {
        let dir = dir();
        for bad in ["https://*", "http://example.com", "ftp://x", "not a url"] {
            assert!(
                add_office(dir.path(), bad, None).is_err(),
                "{bad} must not become an office"
            );
        }
        assert!(load_offices(dir.path()).offices.is_empty());
    }

    #[test]
    fn switching_only_works_for_an_office_you_have() {
        let dir = dir();
        add_office(dir.path(), A, None).expect("added");
        assert!(switch_office(dir.path(), B).is_err());

        add_office(dir.path(), B, None).expect("added");
        switch_office(dir.path(), B).expect("switched");
        assert_eq!(active_office_url(dir.path()).as_deref(), Some(B));
    }

    #[test]
    fn forgetting_the_active_office_falls_back_to_one_that_is_left() {
        let dir = dir();
        add_office(dir.path(), A, None).expect("added");
        add_office(dir.path(), B, None).expect("added");
        switch_office(dir.path(), B).expect("switched");

        remove_office(dir.path(), B).expect("removed");
        assert_eq!(active_office_url(dir.path()).as_deref(), Some(A));

        remove_office(dir.path(), A).expect("removed");
        assert_eq!(active_office_url(dir.path()), None, "back to the picker");
    }

    #[test]
    fn clearing_the_active_office_keeps_the_list() {
        let dir = dir();
        add_office(dir.path(), A, None).expect("added");
        clear_active(dir.path()).expect("cleared");

        assert_eq!(active_office_url(dir.path()), None);
        assert_eq!(load_offices(dir.path()).offices.len(), 1, "still yours");
    }

    /// Nobody should lose the office they were using because the shape of the
    /// setting changed underneath them.
    #[test]
    fn a_single_office_file_is_carried_over() {
        let dir = dir();
        std::fs::write(office_path(dir.path()), format!("{A}/\n")).expect("written");

        let offices = load_offices(dir.path());
        assert_eq!(offices.active.as_deref(), Some(A));
        assert_eq!(offices.offices.len(), 1);
    }

    #[test]
    fn an_unusable_single_office_file_is_not_carried_over() {
        let dir = dir();
        std::fs::write(office_path(dir.path()), "https://*").expect("written");
        assert!(load_offices(dir.path()).offices.is_empty());
    }
}

#[cfg(test)]
mod reachable_tests {
    use super::*;
    use std::net::TcpListener;

    /// The check that decides between the office and an explanation.
    ///
    /// A blank window is what happens when this is not consulted: the webview
    /// leaves the bootstrap page, fails to load, and shows nothing anybody can
    /// read.
    #[test]
    fn something_listening_is_reachable() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let port = listener.local_addr().unwrap().port();
        assert!(reachable(&format!("http://127.0.0.1:{port}")));
    }

    #[test]
    fn nothing_listening_is_not() {
        // Bound and dropped, so the port is real and free — a closed port
        // rather than one that might belong to somebody else.
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
            listener.local_addr().unwrap().port()
        };
        assert!(!reachable(&format!("http://127.0.0.1:{port}")));
    }

    #[test]
    fn nonsense_is_not_reachable() {
        for candidate in ["", "not a url", "file:///etc/passwd", "http://"] {
            assert!(!reachable(candidate), "{candidate} must not look reachable");
        }
    }
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
        // Matched via `url::Host`, so a bracketed literal is an Ipv6 host
        // rather than a string full of characters the glob guard rejects.
        assert!(is_usable_office("http://[::1]:3000"));
        assert!(is_usable_office("https://office.example.com"));

        // Cleartext off this machine. `export_backup` returns the blob and the
        // passphrase, which together are the key, so http to a remote office
        // hands the identity to anyone on the wire.
        assert!(!is_usable_office("http://office.example.com"));
        assert!(!is_usable_office("http://192.168.1.10:3000"));
        // The whole loopback block, since the parser knows what one is.
        assert!(is_usable_office("http://127.0.0.2:3000"));

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

    /// Every declared command must also be granted.
    ///
    /// These are two lists in two files, and Tauri only complains at runtime —
    /// a command in `build.rs` with no matching `allow-` grant is refused the
    /// moment the office calls it, with the app otherwise looking healthy. That
    /// exact mismatch shipped once and made sign-in impossible, so the lists are
    /// compared here rather than trusted to review.
    #[test]
    fn every_declared_command_is_granted() {
        let build_rs = include_str!("../build.rs");
        let declared = build_rs
            .split_once(".commands(&[")
            .expect("build.rs declares a command list")
            .1
            .split_once("])")
            .expect("the list is closed")
            .0;

        let capability = capability_for(Some("https://office.example.com"));
        let mut checked = 0;
        for raw in declared.split('"').skip(1).step_by(2) {
            let permission = format!("allow-{}", raw.replace('_', "-"));
            assert!(
                capability.contains(&permission),
                "`{raw}` is declared in build.rs but never granted, so calling it is refused"
            );
            checked += 1;
        }
        assert!(
            checked >= 9,
            "expected the real command list, found {checked}"
        );
    }

    #[test]
    fn grants_the_commands_by_name_so_a_new_one_is_not_inherited() {
        let capability = capability_for(Some("https://office.example.com"));
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
        // Must NOT be remote-only: in `tauri dev` the office is served from
        // `devUrl`, which Tauri calls a local origin, and excluding local
        // rejects every command in the configuration developers actually use.
        assert!(
            !capability.contains("\"local\":false"),
            "a remote-only grant breaks `tauri dev` entirely",
        );
    }

    #[test]
    fn grants_ipc_to_one_origin_and_no_wildcard() {
        let capability = capability_for(Some("https://office.example.com"));
        assert!(capability.contains("https://office.example.com/*"));
        // The whole point. A wildcard here would hand `sign_challenge` to any
        // page the window can reach.
        assert!(!capability.contains("https://*"));
        assert!(!capability.contains("http://*"));
    }
}

/// Is anything actually listening where the office should be?
///
/// A TCP connect, not a request: this only has to tell "nothing is there" from
/// "something is", and that is the difference between a window that explains
/// itself and a blank one. An office that answers but is broken will render its
/// own error, which is the right place for it.
pub fn reachable(office: &str) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};

    let Ok(url) = office.parse::<url::Url>() else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let Some(port) = url.port_or_known_default() else {
        return false;
    };

    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(400)).is_ok())
}

// --- more than one office ---------------------------------------------------

/// One office this app knows about.
///
/// An office is an *environment*, not a preference: its own people, its own
/// agents, its own registration of this machine. Nothing crosses between two of
/// them, which is why they are a list you move between rather than a URL you
/// edit — editing implies the surroundings survive the change, and they do not.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Office {
    pub url: String,
    /// What to call it in a list. The URL when nobody said otherwise.
    #[serde(default)]
    pub label: String,
}

impl Office {
    fn new(url: String, label: Option<String>) -> Self {
        let label = label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| url.clone());
        Self { url, label }
    }
}

/// Every office, and which one is live.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Offices {
    /// Empty on a genuinely first run, which is what the picker is for.
    #[serde(default)]
    pub offices: Vec<Office>,
    #[serde(default)]
    pub active: Option<String>,
}

impl Offices {
    pub fn active_office(&self) -> Option<&Office> {
        let active = self.active.as_deref()?;
        self.offices.iter().find(|office| office.url == active)
    }

    fn contains(&self, url: &str) -> bool {
        self.offices.iter().any(|office| office.url == url)
    }
}

fn offices_path(dir: &Path) -> PathBuf {
    dir.join(OFFICES_FILE)
}

/// Normalise a URL the way an office is stored: origin, no trailing slash.
///
/// Done before anything compares two of them, because `http://x:3000` and
/// `http://x:3000/` are the same office and would otherwise be two entries with
/// two machine registrations.
fn normalise(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    is_usable_office(&trimmed).then_some(trimmed)
}

/// Read the list, adopting an older single-office file if that is all there is.
pub fn load_offices(dir: &Path) -> Offices {
    if let Ok(text) = std::fs::read_to_string(offices_path(dir)) {
        if let Ok(offices) = serde_json::from_str::<Offices>(&text) {
            return offices;
        }
    }

    // Migration: one office in a text file becomes a list of one. Nobody should
    // lose the office they were using because the shape of the setting changed.
    match std::fs::read_to_string(office_path(dir))
        .ok()
        .and_then(|raw| normalise(&raw))
    {
        Some(url) => Offices {
            offices: vec![Office::new(url.clone(), None)],
            active: Some(url),
        },
        None => Offices::default(),
    }
}

pub fn save_offices(dir: &Path, offices: &Offices) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(offices)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    std::fs::write(offices_path(dir), text)
}

/// Add an office, and make it the active one when there was none.
///
/// Returns the normalised URL. Adding one that is already known is not an
/// error — it is somebody pasting the same address twice, and the right answer
/// is the office they already have.
pub fn add_office(dir: &Path, url: &str, label: Option<String>) -> Result<String, String> {
    let url = normalise(url).ok_or_else(|| {
        format!("{url:?} is not an office this app will connect to. Use https, or http on this machine.")
    })?;

    let mut offices = load_offices(dir);
    if !offices.contains(&url) {
        offices.offices.push(Office::new(url.clone(), label));
    }
    if offices.active.is_none() {
        offices.active = Some(url.clone());
    }
    save_offices(dir, &offices).map_err(|error| error.to_string())?;
    Ok(url)
}

/// Make an office the active one. The caller restarts; see `capability_for`.
pub fn switch_office(dir: &Path, url: &str) -> Result<String, String> {
    let url = normalise(url).ok_or_else(|| format!("{url:?} is not a usable office"))?;
    let mut offices = load_offices(dir);
    if !offices.contains(&url) {
        return Err(format!("{url} is not one of your offices"));
    }
    offices.active = Some(url.clone());
    save_offices(dir, &offices).map_err(|error| error.to_string())?;
    Ok(url)
}

/// Forget an office. Its machine registration goes with it.
pub fn remove_office(dir: &Path, url: &str) -> Result<Offices, String> {
    let url = normalise(url).ok_or_else(|| format!("{url:?} is not a usable office"))?;
    let mut offices = load_offices(dir);
    offices.offices.retain(|office| office.url != url);
    if offices.active.as_deref() == Some(url.as_str()) {
        // Whatever is left, or nothing — which lands on the picker, the same
        // place a first run lands.
        offices.active = offices.offices.first().map(|office| office.url.clone());
    }
    save_offices(dir, &offices).map_err(|error| error.to_string())?;
    Ok(offices)
}

/// Leave every office selected but none active, so the next boot shows the
/// picker.
///
/// How you get *back* to the picker once you are in an office. Clearing the
/// active one rather than remembering "show the picker" keeps a single source
/// of truth: the picker is simply what there is when no office is live, on a
/// first run and on this path alike.
pub fn clear_active(dir: &Path) -> Result<(), String> {
    let mut offices = load_offices(dir);
    offices.active = None;
    save_offices(dir, &offices).map_err(|error| error.to_string())
}
