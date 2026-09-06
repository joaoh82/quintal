//! Which server this app is a window onto.
//!
//! Resolution order: `QUINTAL_SERVER_URL`, then a file the settings screen will
//! write, then localhost. Kept apart from everything else because it decides
//! something security-relevant — see `capability_for` — and that decision
//! deserves to be readable on its own.

use std::path::{Path, PathBuf};
use std::time::Duration;

// The on-disk names predate the decision that a deployment is a "server" and
// the office is what lives on it (QUIN-13). Renaming the files would cost
// every existing install its list for a word nobody reads; the JSON key is
// read under both names for the same reason.
const SERVER_FILE: &str = "office.txt";
const SERVERS_FILE: &str = "offices.json";
const DEFAULT_SERVER: &str = "http://localhost:3000";

/// Is this a URL we are willing to point a window at and grant IPC to?
///
/// The grant is built by interpolating this string into a capability, so a
/// value like `https://*` would become the pattern `https://*/*` and hand every
/// site on the internet the ability to ask this process for a signature.
/// Validated before it is ever used, not after.
pub fn is_usable_server(raw: &str) -> bool {
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

/// `QUINTAL_SERVER_URL`, or the name it had before QUIN-13 settled what a
/// server is. Trimmed, without a trailing slash; empty counts as unset.
fn server_url_from_env() -> Option<String> {
    ["QUINTAL_SERVER_URL", "QUINTAL_OFFICE_URL"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// The configured server URL, normalised to an origin with no trailing slash.
///
/// Anything unusable falls back to the default rather than being trusted: a
/// misconfigured server should land you on localhost, not on a wildcard.
pub fn active_server_url(dir: &Path) -> Option<String> {
    if let Some(from_env) = server_url_from_env() {
        return if is_usable_server(&from_env) {
            Some(from_env)
        } else {
            eprintln!("[quintal] refusing server URL {from_env:?} from the environment");
            None
        };
    }

    // Re-validated on the way out, not trusted because it is on disk.
    // `offices.json` is a file a person can edit, and an unchecked `https://*`
    // becomes `https://*/*` in the grant — the wildcard this module exists to
    // prevent. The old single-server path checked; this one has to as well.
    load_servers(dir)
        .active_server()
        .map(|server| server.url.clone())
        .filter(|url| {
            is_usable_server(url) || {
                eprintln!("[quintal] refusing stored server URL {url:?}");
                false
            }
        })
}

/// The old single-server resolution, kept for callers that must have a URL.
#[allow(dead_code)]
pub fn server_url(dir: &Path) -> String {
    let raw = server_url_from_env()
        .or_else(|| {
            std::fs::read_to_string(server_path(dir))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_SERVER.to_string());

    let trimmed = raw.trim_end_matches('/').to_string();
    if is_usable_server(&trimmed) {
        trimmed
    } else {
        eprintln!("[quintal] refusing server URL {trimmed:?}; using {DEFAULT_SERVER}");
        DEFAULT_SERVER.to_string()
    }
}

pub fn server_path(dir: &Path) -> PathBuf {
    dir.join(SERVER_FILE)
}

/// The capability granting IPC to exactly one origin.
///
/// This is the answer to "who is allowed to ask this process for a signature".
/// Tauri grants remote pages access by URL pattern, and the tempting pattern —
/// `https://*` — would mean any site the window ever navigates to can call
/// `sign_challenge`. The office is a web app with links in it; one wrong click
/// and a stranger's page is talking to the keychain.
///
/// So the grant is built at startup from the configured server and nothing
/// else. Changing servers means restarting, which is the right price.
pub fn capability_for(server: Option<&str>) -> String {
    // No server yet means a first run, and the only page there is the picker
    // this app ships. It still needs to call commands — that is how a server
    // gets added — so the capability exists with nothing remote in it.
    let remote: Vec<String> = match server {
        // Both patterns: `navigate("https://server")` lands on a URL with no
        // path, which `{server}/*` alone does not match.
        Some(server) => vec![server.to_string(), format!("{server}/*")],
        None => Vec::new(),
    };

    // Changing which servers exist is granted **only when none is active**.
    //
    // Otherwise it is granted to the office itself, and a page there — through
    // XSS, or because it is hostile — could `add_server("https://attacker")`,
    // `switch_server` to it, and inherit `sign_challenge` and `export_backup`
    // on the next boot. That is the whole one-origin guarantee handed away by a
    // page that was only ever supposed to ask for a signature.
    //
    // With no active server the only thing loaded is the picker this app ships,
    // so the commands exist exactly while the screen that uses them is up. A
    // server can still call `open_server_picker`, which clears the active server
    // and restarts: annoying if abused, but it lands a human on the picker
    // rather than moving anybody's keys.
    //
    // Deliberately not "local only": in `tauri dev` the server *is* `devUrl`,
    // which Tauri classifies as local, so local-only would grant these to the
    // dev server too.
    let mut permissions: Vec<&str> = vec![
        "core:default",
        // Generated from `AppManifest::commands` in build.rs. Named one by one
        // rather than wildcarded: a command added later should have to be
        // granted deliberately, not inherit a blanket allow.
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
        "allow-list-servers",
        "allow-open-server-picker",
        // Safe from the office: it can only select a server already on the
        // list, which only the picker can add to.
        "allow-switch-server",
    ];
    // Changing **which servers exist** is granted only when none is active,
    // which is exactly when the picker is what is loaded.
    //
    // Granted to the office instead, a page there — through XSS, or because the
    // office is hostile — could `add_server("https://attacker")`, switch to it,
    // and inherit `sign_challenge` and `export_backup` on the next boot: the
    // one-origin guarantee handed away by a page that was only ever supposed to
    // ask for a signature.
    //
    // `switch_server` is *not* in here, and the distinction is the point. It
    // refuses any URL that is not already in the list, so the most an office can
    // do with it is send you to another server you added yourself — somewhere
    // you already trust with the same bridge. Introducing a new origin is the
    // dangerous half, and that is what stays behind the picker.
    //
    // Deliberately not "local only": in `tauri dev` the server *is* `devUrl`,
    // which Tauri classifies as local, so local-only would grant these to the
    // dev server too.
    if server.is_none() {
        permissions.extend(["allow-add-server", "allow-remove-server"]);
    }

    serde_json::json!({
        "identifier": "server-bridge",
        "description": "IPC for the configured server, and nothing else.",
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
        "permissions": permissions
    })
    .to_string()
}

#[cfg(test)]
mod servers_tests {
    use super::*;

    const A: &str = "https://a.example.com";
    const B: &str = "https://b.example.com";

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn a_first_run_has_no_servers_and_no_active_one() {
        let dir = dir();
        let servers = load_servers(dir.path());
        assert!(servers.servers.is_empty());
        assert_eq!(servers.active, None, "which is what the picker is for");
        assert_eq!(active_server_url(dir.path()), None);
    }

    /// Adding is not choosing.
    ///
    /// It used to be: the first server added became active, which meant the
    /// picker hid itself because something was active while nothing had
    /// navigated anywhere — and cancelling the restart left the app on a page
    /// that would never move.
    #[test]
    fn adding_a_server_does_not_make_it_the_active_one() {
        let dir = dir();
        add_server(dir.path(), A, None).expect("added");
        assert_eq!(active_server_url(dir.path()), None);

        switch_server(dir.path(), A).expect("switched");
        assert_eq!(active_server_url(dir.path()).as_deref(), Some(A));

        // ...and adding another does not steal it.
        add_server(dir.path(), B, None).expect("added");
        assert_eq!(active_server_url(dir.path()).as_deref(), Some(A));
    }

    /// A file a person can edit is not a file to trust.
    #[test]
    fn a_stored_server_that_is_not_usable_is_dropped() {
        let dir = dir();
        std::fs::write(
            servers_path(dir.path()),
            // Under the key older installs wrote, which the alias still reads.
            serde_json::json!({
                "offices": [{ "url": "https://*", "label": "sneaky" }],
                "active": "https://*",
            })
            .to_string(),
        )
        .expect("written");

        assert!(load_servers(dir.path()).servers.is_empty(), "not offered");
        assert_eq!(
            active_server_url(dir.path()),
            None,
            "and never interpolated into the grant"
        );
    }

    #[test]
    fn removal_reports_the_normalised_url() {
        let dir = dir();
        add_server(dir.path(), A, None).expect("added");
        let (removed, left) = remove_server(dir.path(), &format!("{A}/")).expect("removed");
        assert_eq!(removed, A, "the caller keys a keychain slot on this");
        assert!(left.servers.is_empty());
    }

    #[test]
    fn the_same_server_twice_is_one_server() {
        let dir = dir();
        add_server(dir.path(), A, None).expect("added");
        // Trailing slash and whitespace are the same address, and two entries
        // would mean two machine registrations for one place.
        add_server(dir.path(), &format!("  {A}/  "), None).expect("added again");
        assert_eq!(load_servers(dir.path()).servers.len(), 1);
    }

    #[test]
    fn a_server_this_app_will_not_connect_to_is_refused() {
        let dir = dir();
        for bad in ["https://*", "http://example.com", "ftp://x", "not a url"] {
            assert!(
                add_server(dir.path(), bad, None).is_err(),
                "{bad} must not become a server"
            );
        }
        assert!(load_servers(dir.path()).servers.is_empty());
    }

    #[test]
    fn switching_only_works_for_a_server_you_have() {
        let dir = dir();
        add_server(dir.path(), A, None).expect("added");
        assert!(switch_server(dir.path(), B).is_err());

        add_server(dir.path(), B, None).expect("added");
        switch_server(dir.path(), B).expect("switched");
        assert_eq!(active_server_url(dir.path()).as_deref(), Some(B));
    }

    #[test]
    fn forgetting_the_active_server_falls_back_to_one_that_is_left() {
        let dir = dir();
        add_server(dir.path(), A, None).expect("added");
        add_server(dir.path(), B, None).expect("added");
        switch_server(dir.path(), B).expect("switched");

        remove_server(dir.path(), B).expect("removed");
        assert_eq!(active_server_url(dir.path()).as_deref(), Some(A));

        remove_server(dir.path(), A).expect("removed");
        assert_eq!(active_server_url(dir.path()), None, "back to the picker");
    }

    #[test]
    fn clearing_the_active_server_keeps_the_list() {
        let dir = dir();
        add_server(dir.path(), A, None).expect("added");
        clear_active(dir.path()).expect("cleared");

        assert_eq!(active_server_url(dir.path()), None);
        assert_eq!(load_servers(dir.path()).servers.len(), 1, "still yours");
    }

    /// Nobody should lose the server they were using because the shape of the
    /// setting changed underneath them.
    #[test]
    fn a_single_server_file_is_carried_over() {
        let dir = dir();
        std::fs::write(server_path(dir.path()), format!("{A}/\n")).expect("written");

        let servers = load_servers(dir.path());
        assert_eq!(servers.active.as_deref(), Some(A));
        assert_eq!(servers.servers.len(), 1);
    }

    #[test]
    fn an_unusable_single_server_file_is_not_carried_over() {
        let dir = dir();
        std::fs::write(server_path(dir.path()), "https://*").expect("written");
        assert!(load_servers(dir.path()).servers.is_empty());
    }
}

#[cfg(test)]
mod reachable_tests {
    use super::*;
    use std::net::TcpListener;

    /// The check that decides between the server and an explanation.
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
        assert_eq!(server_url(dir.path()), DEFAULT_SERVER);
    }

    #[test]
    fn reads_a_configured_server_and_drops_the_trailing_slash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(server_path(dir.path()), "https://server.example.com/\n").unwrap();
        assert_eq!(server_url(dir.path()), "https://server.example.com");
    }

    #[test]
    fn refuses_server_urls_that_could_widen_the_grant() {
        assert!(is_usable_server("http://localhost:3000"));
        assert!(is_usable_server("http://127.0.0.1:3000"));
        // Matched via `url::Host`, so a bracketed literal is an Ipv6 host
        // rather than a string full of characters the glob guard rejects.
        assert!(is_usable_server("http://[::1]:3000"));
        assert!(is_usable_server("https://server.example.com"));

        // Cleartext off this machine. `export_backup` returns the blob and the
        // passphrase, which together are the key, so http to a remote server
        // hands the identity to anyone on the wire.
        assert!(!is_usable_server("http://server.example.com"));
        assert!(!is_usable_server("http://192.168.1.10:3000"));
        // The whole loopback block, since the parser knows what one is.
        assert!(is_usable_server("http://127.0.0.2:3000"));

        // The one that matters: a glob here becomes `https://*/*` in the
        // capability, which is every site on the internet.
        assert!(!is_usable_server("https://*"));
        assert!(!is_usable_server("https://*.example.com"));
        assert!(!is_usable_server("file:///etc/passwd"));
        assert!(!is_usable_server("javascript:alert(1)"));
        assert!(!is_usable_server("not a url"));
        assert!(!is_usable_server(""));
    }

    #[test]
    fn an_unusable_server_falls_back_rather_than_being_trusted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(server_path(dir.path()), "https://*").unwrap();
        assert_eq!(server_url(dir.path()), DEFAULT_SERVER);
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

        // The union of both configurations: with a server active, and
        // without. Some commands are deliberately only granted in one of them
        // — see `capability_for` — but a command granted in *neither* is one
        // nothing can ever call.
        let granted = format!(
            "{}{}",
            capability_for(Some("https://server.example.com")),
            capability_for(None),
        );

        let mut checked = 0;
        for raw in declared.split('"').skip(1).step_by(2) {
            let permission = format!("allow-{}", raw.replace('_', "-"));
            assert!(
                granted.contains(&permission),
                "`{raw}` is declared in build.rs but never granted, so calling it is refused"
            );
            checked += 1;
        }
        assert!(
            checked >= 9,
            "expected the real command list, found {checked}"
        );
    }

    /// The office may not choose which server comes next.
    ///
    /// Granting these to the office origin means a page there — through XSS, or
    /// because the office is hostile — can add an attacker's URL, switch to it,
    /// and inherit `sign_challenge` and `export_backup` on the next boot. The
    /// one-origin guarantee would be handed away by a page that was only ever
    /// supposed to ask for a signature.
    #[test]
    fn an_active_server_cannot_change_which_servers_exist() {
        let capability = capability_for(Some("https://server.example.com"));
        for forbidden in ["allow-add-server", "allow-remove-server"] {
            assert!(
                !capability.contains(forbidden),
                "{forbidden} must not be granted while a server is loaded"
            );
        }
        // It may still ask to be sent to the picker, where a human decides —
        // and may switch between servers already on the list, which cannot
        // introduce an origin nobody chose.
        assert!(capability.contains("allow-open-server-picker"));
        assert!(capability.contains("allow-switch-server"));
        assert!(capability.contains("allow-sign-challenge"));
    }

    #[test]
    fn the_picker_may_change_them_because_nothing_else_is_loaded() {
        let capability = capability_for(None);
        for allowed in ["allow-add-server", "allow-remove-server"] {
            assert!(
                capability.contains(allowed),
                "{allowed} is the picker's job"
            );
        }
        assert!(
            !capability.contains("server.example.com"),
            "and no remote origin is granted anything at all"
        );
    }

    #[test]
    fn grants_the_commands_by_name_so_a_new_one_is_not_inherited() {
        let capability = capability_for(Some("https://server.example.com"));
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
        let capability = capability_for(Some("https://server.example.com"));
        assert!(capability.contains("https://server.example.com/*"));
        // The whole point. A wildcard here would hand `sign_challenge` to any
        // page the window can reach.
        assert!(!capability.contains("https://*"));
        assert!(!capability.contains("http://*"));
    }
}

/// Is anything actually listening where the server should be?
///
/// A TCP connect, not a request: this only has to tell "nothing is there" from
/// "something is", and that is the difference between a window that explains
/// itself and a blank one. A server that answers but is broken will render its
/// own error, which is the right place for it.
pub fn reachable(server: &str) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};

    let Ok(url) = server.parse::<url::Url>() else {
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

// --- more than one server ---------------------------------------------------

/// One server this app knows about.
///
/// A server is an *environment*, not a preference: its own people, its own
/// agents, its own registration of this machine. Nothing crosses between two of
/// them, which is why they are a list you move between rather than a URL you
/// edit — editing implies the surroundings survive the change, and they do not.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Server {
    pub url: String,
    /// What to call it in a list. The URL when nobody said otherwise.
    #[serde(default)]
    pub label: String,
}

impl Server {
    fn new(url: String, label: Option<String>) -> Self {
        let label = label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| url.clone());
        Self { url, label }
    }
}

/// Every server, and which one is live.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Servers {
    /// Empty on a genuinely first run, which is what the picker is for.
    #[serde(default, alias = "offices")]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub active: Option<String>,
}

impl Servers {
    pub fn active_server(&self) -> Option<&Server> {
        let active = self.active.as_deref()?;
        self.servers.iter().find(|server| server.url == active)
    }

    fn contains(&self, url: &str) -> bool {
        self.servers.iter().any(|server| server.url == url)
    }
}

fn servers_path(dir: &Path) -> PathBuf {
    dir.join(SERVERS_FILE)
}

/// Normalise a URL the way a server is stored: origin, no trailing slash.
///
/// Done before anything compares two of them, because `http://x:3000` and
/// `http://x:3000/` are the same server and would otherwise be two entries with
/// two machine registrations.
fn normalise(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    is_usable_server(&trimmed).then_some(trimmed)
}

/// Read the list, adopting an older single-server file if that is all there is.
pub fn load_servers(dir: &Path) -> Servers {
    if let Ok(text) = std::fs::read_to_string(servers_path(dir)) {
        if let Ok(mut servers) = serde_json::from_str::<Servers>(&text) {
            // Filtered on the way in. A hand-edited or corrupted file should
            // not be able to put a wildcard in front of somebody, whether it
            // reaches the capability or only the picker.
            servers
                .servers
                .retain(|server| is_usable_server(&server.url));
            if let Some(active) = servers.active.clone() {
                if !servers.contains(&active) {
                    servers.active = None;
                }
            }
            return servers;
        }
    }

    // Migration: one server in a text file becomes a list of one. Nobody should
    // lose the server they were using because the shape of the setting changed.
    match std::fs::read_to_string(server_path(dir))
        .ok()
        .and_then(|raw| normalise(&raw))
    {
        Some(url) => Servers {
            servers: vec![Server::new(url.clone(), None)],
            active: Some(url),
        },
        None => Servers::default(),
    }
}

pub fn save_servers(dir: &Path, servers: &Servers) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(servers)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    std::fs::write(servers_path(dir), text)
}

/// Add a server, and make it the active one when there was none.
///
/// Returns the normalised URL. Adding one that is already known is not an
/// error — it is somebody pasting the same address twice, and the right answer
/// is the server they already have.
pub fn add_server(dir: &Path, url: &str, label: Option<String>) -> Result<String, String> {
    let url = normalise(url).ok_or_else(|| {
        format!(
            "{url:?} is not a server this app will connect to. Use https, or http on this machine."
        )
    })?;

    let mut servers = load_servers(dir);
    if !servers.contains(&url) {
        servers.servers.push(Server::new(url.clone(), label));
    }
    // Adding a server is not choosing one. Making the first one active here
    // was a side effect the picker then had to reason about: it hid itself
    // because something was active, while nothing had navigated anywhere, and
    // cancelling the restart left the app on a page that would never move.
    save_servers(dir, &servers).map_err(|error| error.to_string())?;
    Ok(url)
}

/// Make a server the active one. The caller restarts; see `capability_for`.
pub fn switch_server(dir: &Path, url: &str) -> Result<String, String> {
    let url = normalise(url).ok_or_else(|| format!("{url:?} is not a usable server"))?;
    let mut servers = load_servers(dir);
    if !servers.contains(&url) {
        return Err(format!("{url} is not one of your servers"));
    }
    servers.active = Some(url.clone());
    save_servers(dir, &servers).map_err(|error| error.to_string())?;
    Ok(url)
}

/// Forget a server. Its machine registration goes with it.
pub fn remove_server(dir: &Path, url: &str) -> Result<(String, Servers), String> {
    let url = normalise(url).ok_or_else(|| format!("{url:?} is not a usable server"))?;
    let mut servers = load_servers(dir);
    servers.servers.retain(|server| server.url != url);
    if servers.active.as_deref() == Some(url.as_str()) {
        // Whatever is left, or nothing — which lands on the picker, the same
        // place a first run lands.
        servers.active = servers.servers.first().map(|server| server.url.clone());
    }
    save_servers(dir, &servers).map_err(|error| error.to_string())?;
    // The normalised URL, because the caller uses it as a keychain slot suffix.
    // Forgetting `https://server/` while the slot says `https://server` leaves a
    // machine token behind for a server that is gone.
    Ok((url, servers))
}

/// Leave every server known but none active, so the next boot shows the
/// picker.
///
/// How you get *back* to the picker once you are in an office. Clearing the
/// active one rather than remembering "show the picker" keeps a single source
/// of truth: the picker is simply what there is when no server is live, on a
/// first run and on this path alike.
pub fn clear_active(dir: &Path) -> Result<(), String> {
    let mut servers = load_servers(dir);
    servers.active = None;
    save_servers(dir, &servers).map_err(|error| error.to_string())
}
