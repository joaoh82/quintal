//! Where a link goes: the office stays in the window, everything else goes
//! to the system browser.
//!
//! The webview is granted IPC for exactly one origin — the server's — and a
//! page from anywhere else loaded into it would be a page with a bridge to
//! the keychain it was never meant to have. So the window never navigates
//! off the server. A link to the docs, GitHub or the website opens where a
//! link like that belongs, in the browser the person already uses, whether
//! it asked for a new window or not.

use tauri::Url;

/// Should this URL leave the app?
///
/// Anything on the server's origin is the office and stays. The app's own
/// pages (`tauri://`, `tauri.localhost`) and `about:blank` stay. Every other
/// web address goes out.
pub fn is_external(server: Option<&str>, url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => {}
        "mailto" => return true,
        _ => return false,
    }
    if url.host_str().is_some_and(|host| host == "tauri.localhost") {
        return false;
    }
    match server.and_then(|raw| Url::parse(raw).ok()) {
        Some(home) => !same_origin(&home, url),
        // No server chosen yet: nothing on the web is the office.
        None => true,
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
    if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("[quintal] could not open {url} in the browser: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: Option<&str> = Some("http://localhost:3000");

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("a url")
    }

    #[test]
    fn the_office_stays_in_the_window() {
        assert!(!is_external(SERVER, &url("http://localhost:3000/office")));
        assert!(!is_external(
            SERVER,
            &url("http://localhost:3000/settings/agents?x=1")
        ));
    }

    #[test]
    fn the_same_host_on_another_port_is_somewhere_else() {
        // A second office on this machine is a different server, and the
        // window must not carry its IPC grant across.
        assert!(is_external(SERVER, &url("http://localhost:3100/office")));
        assert!(is_external(SERVER, &url("https://localhost:3000/office")));
    }

    #[test]
    fn the_web_goes_to_the_browser() {
        assert!(is_external(SERVER, &url("https://quintal.sh/docs/")));
        assert!(is_external(
            SERVER,
            &url("https://github.com/joaoh82/quintal")
        ));
        assert!(is_external(SERVER, &url("mailto:hello@quintal.sh")));
    }

    #[test]
    fn the_apps_own_pages_stay() {
        assert!(!is_external(SERVER, &url("tauri://localhost/index.html")));
        assert!(!is_external(
            SERVER,
            &url("http://tauri.localhost/index.html")
        ));
        assert!(!is_external(SERVER, &url("about:blank")));
    }

    #[test]
    fn with_no_server_chosen_nothing_on_the_web_is_home() {
        assert!(is_external(None, &url("http://localhost:3000/office")));
        assert!(!is_external(None, &url("tauri://localhost/index.html")));
    }

    #[test]
    fn a_hosted_office_is_home_on_its_default_port() {
        let hosted = Some("https://office.example.com");
        assert!(!is_external(
            hosted,
            &url("https://office.example.com:443/settings")
        ));
        assert!(is_external(hosted, &url("https://docs.example.com/")));
    }
}
