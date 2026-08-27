//! Running this machine's agents.
//!
//! The office cannot start a process on your computer — it is a web page, and
//! that is the whole security story. What it can do is say *which agents belong
//! to this machine*; the harness pulls that list and spawns them, choosing each
//! command from the shared runtime catalogue rather than from anything the
//! office sent. So a compromised office can pick from a fixed menu. It cannot
//! write the menu, and it cannot hand over a command line.
//!
//! One child process, not one per agent. The harness is already a supervisor
//! that reconciles a running fleet against the list the office publishes —
//! adding what appeared, stopping what went away — so an agent is enabled by
//! being in that list and disabled by leaving it. Duplicating that here would
//! mean two things deciding what should be running, which is one more than can
//! ever agree.
//!
//! Two rules for the credential:
//!
//! - **It goes in the environment, at spawn.** Never argv, which every process
//!   on the machine can read out of `ps`, and never a file, which outlives the
//!   process that needed it.
//! - **The host token is the credential.** Agents defined in the office have no
//!   key of their own on purpose — a key the office could hand out is a key the
//!   office would have to be able to read back.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use thiserror::Error;

use crate::runtimes;

/// How long the fleet gets to wind up on its own before it is killed.
const GRACE: Duration = Duration::from_secs(5);

/// How many log lines to keep.
///
/// Bounded because this runs for as long as the app does, and an unbounded
/// buffer behind a chatty agent is a memory leak with a scrollback. The old
/// lines are the ones you want least — a crash explains itself at the end.
const LOG_LINES: usize = 500;

/// Env vars the harness reads its machine credential and office from.
///
/// Named by the harness rather than by us: `readStoredHost` prefers these over
/// `~/.quintal/host.json`, which is what lets the app run a harness that never
/// had a `login` step and never writes a token to disk.
const TOKEN_ENV: &str = "QUINTAL_HOST_TOKEN";
const URL_ENV: &str = "QUINTAL_URL";

#[derive(Debug, Error)]
pub enum SpawnError {
    #[error("this machine has not registered with an office yet")]
    NotRegistered,
    #[error("{0} is not a directory this machine can work in")]
    BadWorkspace(String),
    #[error("the fleet is already running here")]
    AlreadyRunning,
    #[error("nothing is running here")]
    NotRunning,
    #[error("could not find the quintal-acp harness on PATH; set QUINTAL_ACP_BIN to its path")]
    NoHarness,
    #[error("could not start the fleet: {0}")]
    Io(String),
}

/// What running the fleet means, once resolved.
///
/// Carries **no credential**. The token is applied to the process at spawn and
/// never stored beside the command, so nothing that logs or debugs a plan can
/// leak it — `a_credential_never_appears_in_the_plan` pins that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum FleetState {
    Running {
        pid: u32,
    },
    /// Never started, or stopped when asked. The ordinary states.
    Stopped,
    /// Ended on its own. A fact worth showing rather than a silence the office
    /// has to infer from agents that quietly stopped answering.
    Crashed {
        code: Option<i32>,
    },
}

/// Resolve a run into something spawnable, or refuse it.
///
/// `harness` is a parameter rather than looked up here so tests can drive the
/// whole path without a `quintal-acp` on PATH.
pub fn plan(harness: &Path, repos_dir: &Path) -> Result<Plan, SpawnError> {
    if !repos_dir.is_dir() {
        return Err(SpawnError::BadWorkspace(repos_dir.display().to_string()));
    }

    Ok(Plan {
        program: harness.to_path_buf(),
        // No runtime ids and no commands: `up` asks the office what this machine
        // should run and resolves each id through the catalogue itself.
        args: vec![
            "up".into(),
            "--repos-dir".into(),
            repos_dir.display().to_string(),
        ],
        cwd: repos_dir.to_path_buf(),
    })
}

/// File holding this machine's non-secret preferences.
///
/// Beside the secrets blob but deliberately not in it: a repos directory is a
/// path, not a credential, and putting it behind the keychain would mean the
/// app could not tell you where it was going to work without prompting for
/// unlock first.
const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Default, Serialize, serde::Deserialize)]
struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repos_dir: Option<String>,
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join(SETTINGS_FILE)
}

fn read_settings(dir: &Path) -> Settings {
    std::fs::read_to_string(settings_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// The repos directory this machine should use: chosen if there is one, else
/// the default the harness would have picked anyway.
pub fn repos_dir(app_dir: &Path) -> PathBuf {
    read_settings(app_dir)
        .repos_dir
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(default_repos_dir)
}

/// Remember a chosen repos directory.
pub fn set_repos_dir(app_dir: &Path, chosen: &Path) -> Result<(), SpawnError> {
    if !chosen.is_dir() {
        return Err(SpawnError::BadWorkspace(chosen.display().to_string()));
    }
    let settings = Settings {
        repos_dir: Some(chosen.display().to_string()),
    };
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|error| SpawnError::Io(error.to_string()))?;
    std::fs::write(settings_path(app_dir), text).map_err(|error| SpawnError::Io(error.to_string()))
}

/// Where this machine keeps its repositories, matching the harness's default.
///
/// The two must agree: the harness resolves a relative `repoSpec` against this,
/// so a different answer here would send an agent to a different directory than
/// the office believes it is working in.
pub fn default_repos_dir() -> PathBuf {
    if let Some(explicit) = std::env::var_os("QUINTAL_REPOS_DIR") {
        return PathBuf::from(explicit);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join("projects")
}

/// One checkout under the repos directory.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    /// What to write in an agent's workspace field.
    pub name: String,
    /// Whether it is a git checkout. Shown, not enforced — plenty of useful
    /// directories are not repositories, and refusing them would be a rule
    /// nobody asked for.
    pub git: bool,
}

/// What is in the repos directory, for choosing an agent's workspace.
///
/// One level deep, and no hidden directories. The office cannot see anybody's
/// filesystem, so this is the only way a workspace picker can offer real names
/// rather than asking somebody to type a path exactly right.
pub fn list_repos(repos_dir: &Path) -> Vec<Repo> {
    let Ok(entries) = std::fs::read_dir(repos_dir) else {
        return Vec::new();
    };

    let mut repos: Vec<Repo> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let git = entry.path().join(".git").exists();
            Some(Repo { name, git })
        })
        .collect();

    // Git checkouts first, then alphabetical: the thing being looked for is
    // almost always a repository.
    repos.sort_by(|a, b| b.git.cmp(&a.git).then_with(|| a.name.cmp(&b.name)));
    repos
}

/// Find the harness.
///
/// Beside this executable first. That is where a bundled app keeps it — the
/// whole reason the harness is compiled into the bundle is that a packaged app
/// has neither the repo's `node_modules/.bin` nor, launched from Finder, any
/// PATH worth searching. Looking next to ourselves needs no environment to be
/// right.
///
/// `QUINTAL_ACP_BIN` still wins, for development and CI; PATH is the last
/// resort, for somebody running a `quintal-acp` they installed themselves.
pub fn harness_path() -> Result<PathBuf, SpawnError> {
    if let Some(explicit) = std::env::var_os("QUINTAL_ACP_BIN") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
    }

    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    harness_beside(beside.as_deref())
}

/// The half of `harness_path` that does not depend on where this test happens
/// to be running from — see `start_with` for why that matters.
fn harness_beside(exe_dir: Option<&Path>) -> Result<PathBuf, SpawnError> {
    if let Some(found) = exe_dir
        .map(|dir| dir.join("quintal-acp"))
        .filter(|path| path.is_file())
    {
        return Ok(found);
    }
    runtimes::resolve("quintal-acp").ok_or(SpawnError::NoHarness)
}

/// One line the harness wrote.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// `out` or `err`. The harness writes agent output to one and its own
    /// complaints to the other, and telling them apart is most of the value.
    pub stream: String,
    pub text: String,
}

/// A bounded window onto what the harness has been saying.
#[derive(Default)]
struct LogBuffer {
    lines: Mutex<VecDeque<LogLine>>,
}

impl LogBuffer {
    fn push(&self, stream: &str, text: String) {
        let mut lines = self.lines.lock().expect("log lock");
        if lines.len() == LOG_LINES {
            lines.pop_front();
        }
        lines.push_back(LogLine {
            stream: stream.to_string(),
            text,
        });
    }

    fn snapshot(&self) -> Vec<LogLine> {
        self.lines
            .lock()
            .expect("log lock")
            .iter()
            .cloned()
            .collect()
    }

    fn clear(&self) {
        self.lines.lock().expect("log lock").clear();
    }
}

/// The fleet this machine is running.
#[derive(Default)]
pub struct Fleet {
    child: Mutex<Option<Child>>,
    /// How the last run ended, so "not running" can say why.
    last: Mutex<Option<FleetState>>,
    logs: Arc<LogBuffer>,
}

impl Fleet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(
        &self,
        repos_dir: &Path,
        office: &str,
        host_token: &str,
    ) -> Result<FleetState, SpawnError> {
        self.start_with(&harness_path()?, repos_dir, office, host_token)
    }

    /// See `identity::load_or_create_with` for why the harness is an argument:
    /// finding it through the environment would make these tests unable to run
    /// beside each other, which has already cost this codebase a day.
    pub fn start_with(
        &self,
        harness: &Path,
        repos_dir: &Path,
        office: &str,
        host_token: &str,
    ) -> Result<FleetState, SpawnError> {
        if host_token.trim().is_empty() {
            return Err(SpawnError::NotRegistered);
        }

        let mut slot = self.child.lock().expect("fleet lock");
        if let Some(child) = slot.as_mut() {
            // "Already running" has to mean *still* running: a child that died
            // leaves its handle behind, and refusing to restart it would strand
            // the fleet until the app was relaunched.
            match child.try_wait() {
                Ok(None) => return Err(SpawnError::AlreadyRunning),
                _ => {
                    *slot = None;
                }
            }
        }

        let plan = plan(harness, repos_dir)?;
        let mut child = Command::new(&plan.program)
            .args(&plan.args)
            .current_dir(&plan.cwd)
            .env(TOKEN_ENV, host_token)
            .env(URL_ENV, office)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| SpawnError::Io(error.to_string()))?;

        let pid = child.id();

        // Read both pipes on their own threads. Not optional: the pipes are
        // fixed-size, and a harness that fills one while nobody reads it blocks
        // forever — which looks exactly like an agent that hung.
        self.logs.clear();
        if let Some(out) = child.stdout.take() {
            drain(out, "out", Arc::clone(&self.logs));
        }
        if let Some(err) = child.stderr.take() {
            drain(err, "err", Arc::clone(&self.logs));
        }

        *slot = Some(child);
        *self.last.lock().expect("last lock") = None;
        Ok(FleetState::Running { pid })
    }

    /// Ask the fleet to stop, then insist.
    pub fn stop(&self) -> Result<(), SpawnError> {
        self.stop_within(GRACE)
    }

    /// See `start_with` for why this is a parameter. A test for the *kill* path
    /// has to exhaust the grace period, and a five-second test that exists to
    /// prove a timeout is a five-second test everybody learns to skip.
    pub fn stop_within(&self, grace: Duration) -> Result<(), SpawnError> {
        let mut slot = self.child.lock().expect("fleet lock");
        let Some(mut child) = slot.take() else {
            return Err(SpawnError::NotRunning);
        };
        drop(slot);

        interrupt(&child);

        let deadline = Instant::now() + grace;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }

        *self.last.lock().expect("last lock") = Some(FleetState::Stopped);
        Ok(())
    }

    /// What the harness has said recently.
    pub fn logs(&self) -> Vec<LogLine> {
        self.logs.snapshot()
    }

    /// What this machine is doing, reaping a child that ended on its own.
    pub fn status(&self) -> FleetState {
        let mut slot = self.child.lock().expect("fleet lock");
        if let Some(child) = slot.as_mut() {
            match child.try_wait() {
                Ok(None) => return FleetState::Running { pid: child.id() },
                Ok(Some(status)) => {
                    *slot = None;
                    let state = FleetState::Crashed {
                        code: status.code(),
                    };
                    *self.last.lock().expect("last lock") = Some(state.clone());
                    return state;
                }
                Err(_) => {
                    *slot = None;
                }
            }
        }
        self.last
            .lock()
            .expect("last lock")
            .clone()
            .unwrap_or(FleetState::Stopped)
    }
}

/// Pump one pipe into the buffer until it closes.
///
/// Lossy by design on invalid UTF-8: a log line is for a human to read, and
/// refusing to show the other 499 because one had a stray byte would be a
/// strange trade.
fn drain<R: std::io::Read + Send + 'static>(pipe: R, stream: &'static str, logs: Arc<LogBuffer>) {
    std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines() {
            match line {
                Ok(text) => logs.push(stream, text),
                Err(_) => break,
            }
        }
    });
}

/// Ask a process to wind up, rather than shooting it.
fn interrupt(child: &Child) {
    #[cfg(unix)]
    {
        // Safe: `kill` with a pid we own and a signal number. The worst a stale
        // pid can do is ESRCH, which we ignore — the wait loop then times out
        // and kills, the same outcome as never having sent it.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGINT);
        }
    }
    #[cfg(not(unix))]
    {
        // Windows has no SIGINT to send a child like this; the grace loop falls
        // through to `kill`. Documented rather than pretended otherwise.
        let _ = child;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    /// A stand-in for `quintal-acp` that records how it was called.
    fn fake_harness(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("fake-acp");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o755)
            .open(&path)
            .expect("a fake harness");
        write!(file, "#!/bin/sh\n{body}\n").expect("written");
        path
    }

    /// Wait for a file the child writes once it is genuinely ready.
    ///
    /// Replaces a fixed sleep, which was a race: under a parallel test run the
    /// machine is busy enough that a shell does not reliably reach its `trap`
    /// line within any interval worth waiting. The test then signalled a process
    /// with no handler installed, so the graceful stop it was checking for could
    /// not happen. It failed 9 runs in 10 in the suite and passed 12 in 12
    /// alone, which is exactly the shape of a timing assumption.
    fn wait_for(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(Instant::now() < deadline, "child never became ready");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn office() -> &'static str {
        "http://localhost:3000"
    }

    #[test]
    fn a_chosen_repos_directory_is_remembered() {
        let app = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();

        assert_eq!(
            repos_dir(app.path()),
            default_repos_dir(),
            "unset means default"
        );

        set_repos_dir(app.path(), chosen.path()).expect("remembered");
        assert_eq!(repos_dir(app.path()), chosen.path());
    }

    #[test]
    fn a_chosen_directory_that_has_gone_falls_back_rather_than_failing() {
        let app = tempfile::tempdir().unwrap();
        let chosen = tempfile::tempdir().unwrap();
        set_repos_dir(app.path(), chosen.path()).expect("remembered");
        drop(chosen);

        // A directory that was moved or deleted must not leave the app pointing
        // at nothing — the default still exists and still works.
        assert_eq!(repos_dir(app.path()), default_repos_dir());
    }

    #[test]
    fn a_repos_directory_that_is_not_one_is_refused() {
        let app = tempfile::tempdir().unwrap();
        assert!(set_repos_dir(app.path(), Path::new("/no/such/place")).is_err());
    }

    #[test]
    fn repos_are_listed_with_checkouts_first() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["zebra", "apple"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        std::fs::create_dir_all(dir.path().join("quintal/.git")).unwrap();
        std::fs::create_dir(dir.path().join(".hidden")).unwrap();
        std::fs::write(dir.path().join("a-file"), "").unwrap();

        let repos = list_repos(dir.path());
        let names: Vec<&str> = repos.iter().map(|r| r.name.as_str()).collect();

        assert_eq!(names, vec!["quintal", "apple", "zebra"]);
        assert!(repos[0].git, "the checkout is marked as one");
        assert!(!repos[1].git);
    }

    #[test]
    fn a_repos_directory_that_is_not_there_lists_nothing() {
        assert!(list_repos(Path::new("/no/such/place")).is_empty());
    }

    /// A packaged app has no PATH worth searching and no `node_modules/.bin`,
    /// which is why the harness ships beside the executable — and why looking
    /// there has to come before looking anywhere else.
    #[test]
    fn the_harness_beside_the_executable_wins() {
        let dir = tempfile::tempdir().unwrap();
        let beside = fake_harness(dir.path(), "exit 0");
        std::fs::rename(&beside, dir.path().join("quintal-acp")).expect("named");

        assert_eq!(
            harness_beside(Some(dir.path())).expect("found"),
            dir.path().join("quintal-acp"),
        );
    }

    #[test]
    fn without_one_beside_us_it_falls_back_rather_than_inventing_a_path() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing named quintal-acp here, and (in CI) none on PATH either.
        match harness_beside(Some(dir.path())) {
            Ok(found) => assert_ne!(
                found,
                dir.path().join("quintal-acp"),
                "must not claim a file that is not there"
            ),
            Err(error) => assert!(matches!(error, SpawnError::NoHarness)),
        }
    }

    #[test]
    fn a_machine_with_no_token_starts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let harness = fake_harness(dir.path(), "exit 0");
        let error = Fleet::new()
            .start_with(&harness, dir.path(), office(), "   ")
            .expect_err("must refuse");
        assert!(matches!(error, SpawnError::NotRegistered));
    }

    #[test]
    fn a_workspace_that_is_not_a_directory_is_refused() {
        let error =
            plan(Path::new("/bin/sh"), Path::new("/no/such/place")).expect_err("must refuse");
        assert!(matches!(error, SpawnError::BadWorkspace(_)));
    }

    /// The office supplies no command and no runtime id here — `up` asks for the
    /// list itself and resolves each id through the shared catalogue. Anything
    /// that looked like a command in this argv would be a way in.
    #[test]
    fn the_plan_carries_no_command_from_anywhere_else() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan(Path::new("/bin/sh"), dir.path()).expect("a plan");
        assert_eq!(plan.args[0], "up");
        assert!(!plan.args.iter().any(|a| a.contains("npx")));
        assert!(!plan.args.iter().any(|a| a == "--cmd"));
    }

    #[test]
    fn a_credential_never_appears_in_the_plan() {
        let dir = tempfile::tempdir().unwrap();
        let plan = plan(Path::new("/bin/sh"), dir.path()).expect("a plan");
        let rendered = format!("{plan:?}");
        assert!(!rendered.contains("qh_"), "no token is passed to plan()");
        assert!(!plan.args.iter().any(|a| a.contains("token")));
    }

    /// The one that proves rule two: the credential arrives through the
    /// environment, which is the only way a child can have it without it being
    /// visible in `ps` to every other process on the machine.
    #[test]
    fn the_credential_reaches_the_child_through_its_environment() {
        let dir = tempfile::tempdir().unwrap();
        let seen = dir.path().join("seen");
        let harness = fake_harness(
            dir.path(),
            &format!(
                "printf '%s %s' \"$QUINTAL_HOST_TOKEN\" \"$QUINTAL_URL\" > {}\nwhile :; do :; done\n",
                seen.display()
            ),
        );

        let fleet = Fleet::new();
        fleet
            .start_with(&harness, dir.path(), office(), "qh_secret")
            .expect("started");
        wait_for(&seen);

        assert_eq!(
            std::fs::read_to_string(&seen).expect("recorded"),
            format!("qh_secret {}", office())
        );
        fleet
            .stop_within(Duration::from_millis(500))
            .expect("stopped");
    }

    #[test]
    fn the_fleet_is_not_started_twice() {
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let harness = fake_harness(
            dir.path(),
            &format!("printf ready > {}\nwhile :; do :; done\n", ready.display()),
        );
        let fleet = Fleet::new();

        fleet
            .start_with(&harness, dir.path(), office(), "qh_x")
            .expect("started");
        wait_for(&ready);

        assert!(matches!(
            fleet
                .start_with(&harness, dir.path(), office(), "qh_x")
                .expect_err("must refuse"),
            SpawnError::AlreadyRunning
        ));
        fleet
            .stop_within(Duration::from_millis(500))
            .expect("stopped");
    }

    /// "Already running" has to mean *still* running, or a fleet whose harness
    /// died would be unstartable until the app was relaunched.
    #[test]
    fn a_fleet_whose_harness_died_can_be_started_again() {
        let dir = tempfile::tempdir().unwrap();
        let fleet = Fleet::new();

        let dies = fake_harness(dir.path(), "exit 1");
        fleet
            .start_with(&dies, dir.path(), office(), "qh_x")
            .expect("started");

        let deadline = Instant::now() + Duration::from_secs(10);
        while !matches!(fleet.status(), FleetState::Crashed { .. }) {
            assert!(Instant::now() < deadline, "never noticed it had gone");
            std::thread::sleep(Duration::from_millis(20));
        }

        let ready = dir.path().join("ready");
        let lives = fake_harness(
            dir.path(),
            &format!("printf ready > {}\nwhile :; do :; done\n", ready.display()),
        );
        fleet
            .start_with(&lives, dir.path(), office(), "qh_x")
            .expect("a dead fleet can be restarted");
        wait_for(&ready);
        fleet
            .stop_within(Duration::from_millis(500))
            .expect("stopped");
    }

    #[test]
    fn a_harness_that_exits_on_its_own_is_reported_as_crashed() {
        let dir = tempfile::tempdir().unwrap();
        let harness = fake_harness(dir.path(), "exit 3");
        let fleet = Fleet::new();

        fleet
            .start_with(&harness, dir.path(), office(), "qh_x")
            .expect("started");

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let FleetState::Crashed { code } = fleet.status() {
                assert_eq!(code, Some(3), "the exit code is the diagnosis");
                break;
            }
            assert!(Instant::now() < deadline, "never noticed it had gone");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Both pipes are read, and both must be: an unread pipe fills and blocks
    /// the harness, which looks exactly like an agent that hung.
    #[test]
    fn what_the_harness_says_is_kept_from_both_streams() {
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let harness = fake_harness(
            dir.path(),
            &format!(
                "echo to-stdout\necho to-stderr >&2\nprintf ready > {}\nwhile :; do :; done\n",
                ready.display()
            ),
        );

        let fleet = Fleet::new();
        fleet
            .start_with(&harness, dir.path(), office(), "qh_x")
            .expect("started");
        wait_for(&ready);

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let logs = fleet.logs();
            if logs.len() >= 2 {
                assert!(logs
                    .iter()
                    .any(|l| l.stream == "out" && l.text == "to-stdout"));
                assert!(logs
                    .iter()
                    .any(|l| l.stream == "err" && l.text == "to-stderr"));
                break;
            }
            assert!(Instant::now() < deadline, "never saw both streams");
            std::thread::sleep(Duration::from_millis(20));
        }

        fleet
            .stop_within(Duration::from_millis(500))
            .expect("stopped");
    }

    #[test]
    fn stopping_something_that_is_not_running_says_so() {
        assert!(matches!(
            Fleet::new().stop().expect_err("must refuse"),
            SpawnError::NotRunning
        ));
    }

    /// A well-behaved harness gets to exit on its own.
    ///
    /// The loop is a shell builtin rather than `sleep`: a POSIX shell defers a
    /// trap until the running foreground command finishes, so a script waiting
    /// on `sleep` dies on the default disposition before its handler is reached.
    /// That is a fact about the fake, not about the code under test.
    #[test]
    fn a_stopped_fleet_is_asked_before_it_is_forced() {
        let dir = tempfile::tempdir().unwrap();
        let noted = dir.path().join("caught");
        let ready = dir.path().join("ready");
        let harness = fake_harness(
            dir.path(),
            &format!(
                "trap 'printf caught > {}; exit 0' INT\nprintf ready > {}\nwhile :; do :; done\n",
                noted.display(),
                ready.display()
            ),
        );

        let fleet = Fleet::new();
        fleet
            .start_with(&harness, dir.path(), office(), "qh_x")
            .expect("started");
        wait_for(&ready);

        let started = Instant::now();
        fleet.stop().expect("stopped");

        assert!(
            started.elapsed() < GRACE,
            "it exited on the signal rather than being waited out and killed"
        );
        assert_eq!(
            std::fs::read_to_string(&noted).unwrap_or_default(),
            "caught",
            "the fleet was asked to stop, not shot"
        );
    }

    /// ...and one that refuses to go is still stopped.
    #[test]
    fn a_harness_that_ignores_the_signal_is_killed_anyway() {
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let harness = fake_harness(
            dir.path(),
            &format!(
                "trap '' INT\nprintf ready > {}\nwhile :; do :; done\n",
                ready.display()
            ),
        );

        let fleet = Fleet::new();
        fleet
            .start_with(&harness, dir.path(), office(), "qh_x")
            .expect("started");
        wait_for(&ready);

        fleet
            .stop_within(Duration::from_millis(200))
            .expect("stopped regardless");
        assert!(
            !matches!(fleet.status(), FleetState::Running { .. }),
            "nothing may be left running"
        );
    }
}
