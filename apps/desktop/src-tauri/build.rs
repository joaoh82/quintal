//! Declares the app's own ACL.
//!
//! Without this, `has_app_acl` is false and Tauri's macro takes the "all
//! application commands are allowed" branch. That does *not* open them to the
//! office: for a remote origin the runtime still requires a resolved ACL entry,
//! so the commands are simply rejected and nothing works. Declaring them here
//! generates `allow-<command>` permissions, which `office::capability_for`
//! grants to exactly one origin.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "has_identity",
            "detect_runtimes",
            "get_public_key",
            "sign_challenge",
            "import_identity",
            "export_backup",
            "confirm_backup",
            "can_wipe",
            "wipe_identity",
            "host_status",
            "remember_host_token",
            "forget_host_token",
            "start_fleet",
            "stop_fleet",
            "fleet_status",
            "fleet_logs",
            "repos_dir",
            "list_repos",
            "pick_repos_dir",
        ]),
    ))
    .expect("failed to build the Quintal desktop host");
}
