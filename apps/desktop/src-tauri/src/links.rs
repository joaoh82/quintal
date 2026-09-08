//! Where a link goes: the office stays in the window, everything else goes
//! to the system browser.
//!
//! The webview is granted IPC for exactly one origin — the server's — and a
//! page from anywhere else loaded into it would be a page with a bridge to
//! the keychain it was never meant to have. So the window never navigates
//! off the server. The app's own pages carry no links out — the docs and
//! the repo are on the website people came from — so this is a safety net
//! for whatever else a page might link to: it opens in the browser the
//! person already uses, whether it asked for a new window or not.
//!
//! Done with the `open` crate rather than the opener plugin: the plugin
//! also injects a script that hooks every `target="_blank"` click in the
//! page and routes it through a plugin command, which the capability does
//! not grant — so the office's own new-window links (the audit log) broke
//! with "not allowed by ACL". These hooks need no script and no grant.

use tauri::Url;

/// What the window does with a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The office, or the app's own pages: load it here.
    Stay,
    /// Somewhere on the web, or a mail address: the system browser's job.
    OpenOutside,
    /// Neither — `javascript:`, `data:`, `file:` and whatever else. Nothing
    /// loads, nothing opens. Deny by default next to a keychain bridge.
    Block,
}

/// Where a URL goes.
///
/// Anything on the server's origin is the office and stays. The app's own
/// pages (`tauri://`, `tauri.localhost`) and `about:blank` stay. Every web
/// address elsewhere goes out. Anything that is none of those is refused.
pub fn verdict(server: Option<&str>, url: &Url) -> Verdict {
    match url.scheme() {
        "http" | "https" => {}
        "mailto" => return Verdict::OpenOutside,
        "tauri" | "about" => return Verdict::Stay,
        _ => return Verdict::Block,
    }
    if url.host_str().is_some_and(|host| host == "tauri.localhost") {
        return Verdict::Stay;
    }
    match server.and_then(|raw| Url::parse(raw).ok()) {
        Some(home) if same_origin(&home, url) => Verdict::Stay,
        // Another origin — or no server chosen yet, in which case nothing
        // on the web is the office.
        _ => Verdict::OpenOutside,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host() == b.host()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Hand the URL to the system browser. Logged rather than raised: a link
/// that will not open is not a reason for the app to fall over.
pub fn open_externally(url: &Url) {
    if let Err(error) = open::that_detached(url.as_str()) {
        eprintln!("[quintal] could not open {url} in the browser: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: Option<&str> = Some("http://localhost:3000");

    fn of(server: Option<&str>, raw: &str) -> Verdict {
        verdict(server, &Url::parse(raw).expect("a url"))
    }

    #[test]
    fn the_office_stays_in_the_window() {
        assert_eq!(of(SERVER, "http://localhost:3000/office"), Verdict::Stay);
        assert_eq!(
            of(SERVER, "http://localhost:3000/settings/agents?x=1"),
            Verdict::Stay
        );
    }

    #[test]
    fn the_same_host_on_another_port_is_somewhere_else() {
        // A second office on this machine is a different server, and the
        // window must not carry its IPC grant across.
        assert_eq!(
            of(SERVER, "http://localhost:3100/office"),
            Verdict::OpenOutside
        );
        assert_eq!(
            of(SERVER, "https://localhost:3000/office"),
            Verdict::OpenOutside
        );
    }

    #[test]
    fn the_web_goes_to_the_browser() {
        assert_eq!(of(SERVER, "https://quintal.sh/docs/"), Verdict::OpenOutside);
        assert_eq!(
            of(SERVER, "https://github.com/joaoh82/quintal"),
            Verdict::OpenOutside
        );
        assert_eq!(of(SERVER, "mailto:hello@quintal.sh"), Verdict::OpenOutside);
    }

    #[test]
    fn the_apps_own_pages_stay() {
        assert_eq!(of(SERVER, "tauri://localhost/index.html"), Verdict::Stay);
        assert_eq!(
            of(SERVER, "http://tauri.localhost/index.html"),
            Verdict::Stay
        );
        assert_eq!(of(SERVER, "about:blank"), Verdict::Stay);
    }

    #[test]
    fn anything_else_is_refused_outright() {
        // Not the office, and not something a browser should be handed
        // either: a script URL next to a keychain bridge, a data page that
        // could imitate the office, a local file.
        assert_eq!(of(SERVER, "javascript:alert(1)"), Verdict::Block);
        assert_eq!(of(SERVER, "data:text/html,hello"), Verdict::Block);
        assert_eq!(of(SERVER, "file:///etc/passwd"), Verdict::Block);
    }

    #[test]
    fn with_no_server_chosen_nothing_on_the_web_is_home() {
        assert_eq!(
            of(None, "http://localhost:3000/office"),
            Verdict::OpenOutside
        );
        assert_eq!(of(None, "tauri://localhost/index.html"), Verdict::Stay);
    }

    #[test]
    fn a_hosted_office_is_home_on_its_default_port() {
        let hosted = Some("https://office.example.com");
        assert_eq!(
            of(hosted, "https://office.example.com:443/settings"),
            Verdict::Stay
        );
        assert_eq!(
            of(hosted, "https://docs.example.com/"),
            Verdict::OpenOutside
        );
    }
}
