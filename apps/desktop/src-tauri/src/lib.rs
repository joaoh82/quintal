//! The Quintal desktop host.
//!
//! This is emphatically *not* a second client. The window loads `apps/web` —
//! the same UI a browser gets — and everything native is offered to it through
//! one narrow bridge. Anything added here that the web UI cannot reach, or that
//! duplicates a screen the web app already has, is a mistake.

pub mod identity;
pub mod secrets;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Quintal desktop host");
}
