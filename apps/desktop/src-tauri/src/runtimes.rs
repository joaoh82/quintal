//! Which agent runtimes this machine can actually run.
//!
//! The catalogue is not written here. It is generated from
//! `packages/shared/src/runtimes.ts` — the authored source, comments and all —
//! and read at compile time, so the host and the office cannot disagree about
//! what a runtime id means. CI regenerates and fails on a diff.
//!
//! The host needs the data rather than only a PATH probe because of spawning:
//! the office is a web page, and "never an arbitrary command from the office"
//! means the mapping from a runtime id to an argv has to live on this side of
//! the bridge. A page can ask for `claude-code`; it cannot ask for `rm`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Generated. See `scripts/emit-runtimes.mjs`.
const CATALOGUE_JSON: &str = include_str!("../../../../packages/shared/runtimes.generated.json");

#[derive(Debug, Deserialize)]
struct Catalogue {
    runtimes: Vec<RuntimeSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeSpec {
    pub id: String,
    pub label: String,
    /// What to look for on PATH.
    pub bin: String,
    /// `native`, `adapter` or `none`.
    pub acp: String,
    /// The argv to run, or absent when this runtime cannot speak ACP at all.
    pub command: Option<Vec<String>>,
    pub evidence: String,
    pub install: String,
}

/// What the office is told about one runtime on this machine.
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    pub id: String,
    pub label: String,
    pub installed: bool,
    /// Absolute path the binary resolved to, when it did.
    pub path: Option<String>,
    pub acp: String,
    /// Whether it could actually be launched: on PATH *and* able to speak ACP.
    pub usable: bool,
    /// How the classification was made, so the UI can explain itself rather
    /// than presenting a verdict.
    pub evidence: String,
    pub install: String,
}

pub fn catalogue() -> Vec<RuntimeSpec> {
    let parsed: Catalogue =
        serde_json::from_str(CATALOGUE_JSON).expect("the generated runtime catalogue must parse");
    parsed.runtimes
}

pub fn spec_for(id: &str) -> Option<RuntimeSpec> {
    catalogue().into_iter().find(|spec| spec.id == id)
}

/// The command to launch a runtime, by id.
///
/// The only way a command is produced. Nothing accepts an argv from outside
/// this process, which is what keeps a compromised page from spawning
/// something of its own choosing.
pub fn command_for(id: &str) -> Option<Vec<String>> {
    spec_for(id).and_then(|spec| spec.command)
}

/// Look for a binary on PATH.
///
/// `which` is not shelled out to: that would mean handing a name to a shell,
/// and the name comes from a catalogue but the habit is worth not forming.
/// Walking PATH is a few lines and has no quoting rules.
fn resolve(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(bin);
        is_executable(&candidate).then_some(candidate)
    })
}

fn is_executable(path: &PathBuf) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Probe this machine for every runtime in the catalogue.
pub fn detect() -> Vec<RuntimeStatus> {
    catalogue()
        .into_iter()
        .map(|spec| {
            let found = resolve(&spec.bin);
            let installed = found.is_some();
            RuntimeStatus {
                // Installed but unable to speak ACP is not usable, and saying
                // so here means the UI never offers a runtime that would fail
                // at spawn time with a worse message.
                usable: installed && spec.command.is_some(),
                id: spec.id,
                label: spec.label,
                installed,
                path: found.map(|p| p.to_string_lossy().into_owned()),
                acp: spec.acp,
                evidence: spec.evidence,
                install: spec.install,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generated_catalogue_parses_and_is_not_empty() {
        let all = catalogue();
        assert!(!all.is_empty(), "the office would have nothing to offer");
        assert!(all
            .iter()
            .all(|spec| !spec.id.is_empty() && !spec.bin.is_empty()));
    }

    #[test]
    fn ids_are_unique() {
        // Two entries with one id would make `command_for` return whichever
        // came first, which is a coin toss deciding what gets spawned.
        let all = catalogue();
        let unique: std::collections::HashSet<_> = all.iter().map(|s| &s.id).collect();
        assert_eq!(unique.len(), all.len());
    }

    #[test]
    fn a_command_exists_exactly_when_acp_is_supported() {
        for spec in catalogue() {
            match spec.acp.as_str() {
                "native" | "adapter" => assert!(
                    spec.command.is_some(),
                    "{} claims ACP support with nothing to run",
                    spec.id
                ),
                "none" => assert!(
                    spec.command.is_none(),
                    "{} cannot speak ACP but carries a command",
                    spec.id
                ),
                other => panic!("{} has an unknown acp kind {other:?}", spec.id),
            }
        }
    }

    #[test]
    fn only_known_ids_produce_a_command() {
        // The whole security property of the spawn path: an id the office made
        // up yields nothing to run.
        assert!(command_for("claude-code").is_some());
        assert!(command_for("definitely-not-a-runtime").is_none());
        assert!(command_for("").is_none());
        assert!(command_for("../../bin/sh").is_none());
        assert!(command_for("rm").is_none());
    }

    #[test]
    fn detection_answers_for_every_runtime_in_the_catalogue() {
        let found = detect();
        assert_eq!(found.len(), catalogue().len());
        // Whatever is or is not installed on this machine, an unusable runtime
        // must never be reported usable.
        for status in found {
            if status.usable {
                assert!(status.installed && status.path.is_some());
            }
        }
    }

    #[test]
    fn resolve_finds_something_that_is_definitely_there() {
        // A sanity check on the PATH walk itself, using a binary every unix has.
        #[cfg(unix)]
        {
            assert!(resolve("sh").is_some(), "PATH walking is broken");
            assert!(resolve("definitely-not-a-real-binary-xyzzy").is_none());
        }
    }
}
