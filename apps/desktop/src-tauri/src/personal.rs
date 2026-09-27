//! A personal office: the server, run by this app, for one person.
//!
//! Everything else in this crate assumes a server somebody else is running —
//! Docker on this machine, a deployment somewhere. This module is the other
//! answer: the same production server, started here, as a child of this
//! process, on a loopback port nothing else can reach, with its database in
//! the app's own data directory. The person sees an application. The server
//! is a detail of how it works.
//!
//! What the app ships to make that possible is decided elsewhere — see
//! `scripts/build-personal-payload.mjs` and `scripts/fetch-node-runtime.mjs`.
//! This module finds those two things, starts one on the other, and keeps it
//! running for as long as the app is open:
//!
//! - **Loopback only, never port 3000.** The server's own default is
//!   `0.0.0.0`, which is right for a deployment and wrong for a laptop. Port
//!   3000 is what every developer's other project is on.
//! - **A stable identity, whatever the port.** The port can move (something
//!   else may hold it next launch); the office must not. Every credential
//!   this app keeps for the personal office is keyed on the word
//!   `personal`, not on the origin, and the server binds sessions to the
//!   host rather than the port, so a moved port is a detail the person never
//!   meets.
//! - **The owner is named before the server starts.** Loopback is reachable
//!   by every process on the machine, and a fresh database makes its first
//!   account the admin. The server is told whose office this is, and refuses
//!   everybody else — see `packages/shared/src/personal.ts`.
//! - **Secrets travel in the environment**, never on the command line, the
//!   same rule the fleet follows. The session-signing secret lives in a 0600
//!   file beside the database, as the Docker entrypoint keeps it.
//! - **One copy of the office at a time.** An exclusive lock on the data
//!   directory, held for as long as the server runs, so two launches cannot
//!   race over one SQLite file.
//! - **Backed up before it is upgraded.** A new app version means migrations
//!   may run; the database is copied first, and the last few copies kept.
//! - **Crashes are bounded.** A server that exits on its own is restarted a
//!   few times and then reported, with its last words, rather than
//!   restarted forever behind a window that says nothing.
//! - **It dies with the app.** Stopped on a tidy exit, and holding its stdin
//!   open so that a crash or a force-quit closes the pipe and the server sees
//!   EOF — the one notification that survives every way a parent can die.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::spawn::{drain, LogBuffer, LogLine};

/// The word the personal office is known by everywhere it needs a key: as
/// the active entry in the servers file, and as the slot suffix in the
/// secrets blob. Not a URL on purpose — the URL is whatever port was free.
pub const PERSONAL: &str = "personal";

/// The port every developer has something else on. Never chosen.
const RESERVED_PORT: u16 = 3000;

/// How long the server gets to answer `/health` after being started. Cold
/// starts on a slow disk are real, and a timeout here is reported, not
/// silently retried.
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// How many times a server that exited on its own is started again within
/// `CRASH_WINDOW` before the app stops trying and says so.
const MAX_RESTARTS: u32 = 3;
const CRASH_WINDOW: Duration = Duration::from_secs(300);

/// How long a stop waits for the server to wind up on its own before killing it.
const GRACE: Duration = Duration::from_secs(8);

/// Backups kept per office, oldest dropped first.
const BACKUPS_KEPT: usize = 5;

#[derive(Debug, Error)]
pub enum PersonalError {
    #[error("this build of Quintal carries no personal office payload (looked in {0})")]
    NoPayload(String),
    #[error("this build of Quintal carries no Node runtime for the personal office")]
    NoRuntime,
    #[error("another copy of Quintal is already running this office")]
    AlreadyRunning,
    #[error("could not prepare the personal office: {0}")]
    Io(String),
}

impl From<std::io::Error> for PersonalError {
    fn from(error: std::io::Error) -> Self {
        PersonalError::Io(error.to_string())
    }
}

// --- where things live ------------------------------------------------------

/// The personal office's corner of the app data directory.
#[derive(Debug, Clone)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn under(app_dir: &Path) -> Self {
        Self {
            root: app_dir.join(PERSONAL),
        }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn db(&self) -> PathBuf {
        self.root.join("quintal.db")
    }
    pub fn objects(&self) -> PathBuf {
        self.root.join("objects")
    }
    pub fn auth_secret(&self) -> PathBuf {
        self.root.join("auth-secret")
    }
    pub fn record(&self) -> PathBuf {
        self.root.join("office.json")
    }
    pub fn backups(&self) -> PathBuf {
        self.root.join("backups")
    }
    pub fn lock(&self) -> PathBuf {
        self.root.join("office.lock")
    }
}

/// What this app remembers about its personal office between launches.
///
/// Not the database — that is the office. This is the handful of facts the
/// app needs *before* the server is up: which port it used last time, so the
/// address stays put when it can, and which version last ran, so a new one
/// knows to take a backup first.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Record {
    /// A stable id for this office, minted once. Not used for anything the
    /// server checks; it is what a future "move my office" feature would name.
    #[serde(default)]
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The app version that last brought the server up successfully.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

pub fn read_record(layout: &Layout) -> Record {
    std::fs::read_to_string(layout.record())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn write_record(layout: &Layout, record: &Record) -> Result<(), PersonalError> {
    std::fs::create_dir_all(layout.root())?;
    let text =
        serde_json::to_string_pretty(record).map_err(|e| PersonalError::Io(e.to_string()))?;
    std::fs::write(layout.record(), text)?;
    Ok(())
}

/// The record, created on a first run.
fn load_or_create_record(layout: &Layout) -> Result<Record, PersonalError> {
    let mut record = read_record(layout);
    if record.id.is_empty() {
        let mut bytes = [0u8; 16];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
        record.id = hex::encode(bytes);
        record.created_at = now_stamp();
        write_record(layout, &record)?;
    }
    Ok(record)
}

// --- the payload --------------------------------------------------------------

/// What `scripts/build-personal-payload.mjs` wrote beside the payload.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub entry: String,
    #[serde(default, rename = "webDir")]
    pub web_dir: String,
}

/// The server this build carries, and the runtime to run it on.
#[derive(Debug, Clone)]
pub struct Payload {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub web_dir: PathBuf,
    pub manifest: Manifest,
}

/// Find the payload and the runtime.
///
/// The payload: `QUINTAL_PERSONAL_PAYLOAD` if set — development and CI point
/// it at a tree they built — otherwise `personal/` under the bundle's
/// resource directory, which is where `tauri.personal.conf.json` puts it.
///
/// The runtime: `QUINTAL_NODE_BIN` if set, otherwise `quintal-node` beside
/// this executable, which is where a bundle keeps its external binaries.
/// Deliberately *not* a PATH walk for `node`: a Finder launch has no PATH
/// worth searching, and a personal office running on whichever Node happens
/// to be installed is one that changes when the person upgrades Homebrew.
pub fn locate_payload(
    resource_dir: Option<&Path>,
    exe_dir: Option<&Path>,
) -> Result<Payload, PersonalError> {
    let payload_dir = match std::env::var_os("QUINTAL_PERSONAL_PAYLOAD") {
        Some(explicit) => PathBuf::from(explicit),
        None => resource_dir
            .map(|dir| dir.join(PERSONAL))
            .ok_or_else(|| PersonalError::NoPayload("no resource directory".into()))?,
    };
    let manifest_path = payload_dir.join("payload.json");
    if !manifest_path.is_file() {
        return Err(PersonalError::NoPayload(payload_dir.display().to_string()));
    }
    let manifest: Manifest = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| PersonalError::NoPayload(payload_dir.display().to_string()))?;
    let entry = payload_dir.join(if manifest.entry.is_empty() {
        "node_modules/@quintal/server/dist/index.js"
    } else {
        &manifest.entry
    });
    let web_dir = payload_dir.join(if manifest.web_dir.is_empty() {
        "node_modules/@quintal/web"
    } else {
        &manifest.web_dir
    });
    if !entry.is_file() {
        return Err(PersonalError::NoPayload(payload_dir.display().to_string()));
    }

    let node = std::env::var_os("QUINTAL_NODE_BIN")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            exe_dir
                .map(|dir| {
                    dir.join(if cfg!(windows) {
                        "quintal-node.exe"
                    } else {
                        "quintal-node"
                    })
                })
                .filter(|path| path.is_file())
        })
        .ok_or(PersonalError::NoRuntime)?;

    Ok(Payload {
        node,
        entry,
        web_dir,
        manifest,
    })
}

// --- the port -------------------------------------------------------------------

/// A loopback port the server can have.
///
/// The one it had last time, if it is still free, so the address stays put
/// across launches; otherwise whatever the OS hands out. Never 3000, and
/// never anything but loopback: the bind here is the same bind the server
/// will make moments later, which is as close to "free" as a port check gets.
pub fn choose_port(preferred: Option<u16>) -> Result<u16, PersonalError> {
    if let Some(port) = preferred.filter(|port| *port != RESERVED_PORT && *port >= 1024) {
        if bindable(port) {
            return Ok(port);
        }
    }
    for _ in 0..16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        drop(listener);
        if port != RESERVED_PORT && port >= 1024 {
            return Ok(port);
        }
    }
    Err(PersonalError::Io(
        "could not find a free loopback port".into(),
    ))
}

fn bindable(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The origin the office is served on for a port. `127.0.0.1` rather than
/// `localhost`: the server binds the IPv4 loopback, and a name that may
/// resolve to `::1` first is a connection that may go nowhere.
pub fn origin_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

// --- the secret -------------------------------------------------------------------

/// The session-signing secret, minted once and kept in a 0600 file.
///
/// A fresh secret per boot would sign everybody out at every launch. Kept in
/// a file beside the database rather than in the keychain: it is only ever
/// read by this process to hand to the server, and a keychain prompt for it
/// on every launch would teach people to click through prompts.
pub fn ensure_auth_secret(layout: &Layout) -> Result<String, PersonalError> {
    let path = layout.auth_secret();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if trimmed.len() >= 32 {
            return Ok(trimmed);
        }
    }
    let mut bytes = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    let secret = hex::encode(bytes);
    std::fs::create_dir_all(layout.root())?;
    write_private(&path, format!("{secret}\n").as_bytes())?;
    Ok(secret)
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // `mode` applies only when the file is created. A stub that already
    // existed with looser permissions — a short secret being replaced —
    // would keep them, so they are set explicitly as well.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    Ok(())
}

// --- backups -----------------------------------------------------------------------

/// Copy the database aside before a different app version touches it.
///
/// Migrations run on the server's first boot after an upgrade, and a
/// migration that fails halfway is the one failure with no way back unless
/// this ran first. Returns where the copy went, or `None` when there was
/// nothing to back up or nothing changed.
pub fn backup_before_upgrade(
    layout: &Layout,
    record: &Record,
    version: &str,
) -> Result<Option<PathBuf>, PersonalError> {
    let db = layout.db();
    if !db.is_file() {
        return Ok(None);
    }
    if record.version.as_deref() == Some(version) {
        return Ok(None);
    }
    let from = record.version.as_deref().unwrap_or("unknown");
    let dir = layout
        .backups()
        .join(format!("{}-{from}-to-{version}", now_stamp()));
    std::fs::create_dir_all(&dir)?;
    // The WAL and shared-memory files are part of the database's state
    // between checkpoints; a copy of the main file alone can be behind.
    for suffix in ["", "-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{suffix}", db.display()));
        if source.is_file() {
            std::fs::copy(&source, dir.join(format!("quintal.db{suffix}")))?;
        }
    }
    prune_backups(layout)?;
    Ok(Some(dir))
}

/// Keep the newest `BACKUPS_KEPT`. Names start with a timestamp, so
/// lexical order is chronological.
fn prune_backups(layout: &Layout) -> Result<(), PersonalError> {
    let Ok(entries) = std::fs::read_dir(layout.backups()) else {
        return Ok(());
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    while dirs.len() > BACKUPS_KEPT {
        let oldest = dirs.remove(0);
        std::fs::remove_dir_all(oldest)?;
    }
    Ok(())
}

/// `YYYYMMDD-HHMMSS` in UTC, with no dependency for the calendar.
fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days, Howard Hinnant's algorithm.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}{mo:02}{d:02}-{h:02}{m:02}{s:02}")
}

// --- the environment -----------------------------------------------------------------

/// What the server is told, and nothing the shell had to say about it.
///
/// Built from a clean slate plus the handful of variables a process needs to
/// run at all. Everything about *where data goes* is set here and only here:
/// a `DATABASE_URL` in somebody's shell profile must not redirect their
/// personal office into a development database, and a stray `HOST=0.0.0.0`
/// must not put it on the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawn {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Public variables. The two secrets — the session secret and, well,
    /// nothing else — are applied at spawn and never appear here, so a
    /// debug print of the plan cannot leak them.
    pub env: Vec<(String, String)>,
}

pub struct Settings<'a> {
    pub payload: &'a Payload,
    pub layout: &'a Layout,
    pub port: u16,
    pub owner_pubkey: &'a str,
}

pub fn plan(settings: &Settings<'_>) -> Spawn {
    let Settings {
        payload,
        layout,
        port,
        owner_pubkey,
    } = settings;
    let origin = origin_for(*port);
    let mut env: Vec<(String, String)> = Vec::new();

    // The process basics, inherited when present. PATH is included so the
    // server can find `git` and friends if it ever needs them; nothing on it
    // decides which Node runs, because the program path is absolute.
    for name in [
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SystemRoot",
        "SYSTEMROOT",
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
        "ComSpec",
        "PATHEXT",
    ] {
        if let Ok(value) = std::env::var(name) {
            env.push((name.to_string(), value));
        }
    }

    let data = layout.root().display().to_string();
    env.extend(
        [
            ("NODE_ENV", "production".to_string()),
            ("NEXT_TELEMETRY_DISABLED", "1".to_string()),
            ("HOST", "127.0.0.1".to_string()),
            ("PORT", port.to_string()),
            ("QUINTAL_DATA_ROOT", data),
            ("DATABASE_URL", format!("file:{}", layout.db().display())),
            (
                "STORAGE_URL",
                format!("file:{}", layout.objects().display()),
            ),
            // Real disk, by construction: this is the person's own computer.
            ("STORAGE_ALLOW_LOCAL", "1".to_string()),
            ("BETTER_AUTH_URL", origin),
            ("QUINTAL_WEB_DIR", payload.web_dir.display().to_string()),
            ("QUINTAL_PERSONAL_OWNER", (*owner_pubkey).to_string()),
            // Stop when the pipe this process holds open closes — see the
            // stdin note at spawn, and the matching handler in
            // apps/server/src/index.ts.
            ("QUINTAL_EXIT_WITH_PARENT", "1".to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v)),
    );

    Spawn {
        program: payload.node.clone(),
        args: vec![payload.entry.display().to_string()],
        cwd: layout.root().to_path_buf(),
        env,
    }
}

// --- the supervisor ------------------------------------------------------------------

/// What the office is doing, for the page that is waiting on it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `starting`, `ready`, `failed` or `stopped`.
    pub phase: String,
    /// Where the office is, once it is anywhere.
    pub origin: Option<String>,
    /// A sentence for a person, when there is something to say.
    pub message: Option<String>,
    /// Times the server was restarted after exiting on its own.
    pub restarts: u32,
    pub pid: Option<u32>,
    /// Where the database and objects live, so an error can say so.
    pub data_dir: String,
    /// The backup taken before this launch, if one was.
    pub backup: Option<String>,
}

struct Inner {
    child: Option<Child>,
    status: Status,
    stopping: bool,
    /// Moments the server exited on its own, for the restart budget.
    crashes: Vec<Instant>,
    /// Held while the server runs. Dropping it releases the lock.
    lock: Option<std::fs::File>,
}

/// The personal office's server, supervised.
pub struct Office {
    layout: Layout,
    payload: Payload,
    port: u16,
    owner_pubkey: String,
    version: String,
    inner: Arc<Mutex<Inner>>,
    logs: Arc<LogBuffer>,
}

impl Office {
    /// Everything that can be decided before the server starts.
    ///
    /// Chooses and records the port, so the origin — and with it the IPC
    /// grant — is known before the window exists. Does not spawn anything.
    pub fn prepare(
        app_dir: &Path,
        payload: Payload,
        owner_pubkey: &str,
        version: &str,
    ) -> Result<Self, PersonalError> {
        let layout = Layout::under(app_dir);
        std::fs::create_dir_all(layout.root())?;
        let mut record = load_or_create_record(&layout)?;
        let port = choose_port(record.port)?;
        if record.port != Some(port) {
            record.port = Some(port);
            write_record(&layout, &record)?;
        }
        let status = Status {
            phase: "starting".into(),
            origin: None,
            message: None,
            restarts: 0,
            pid: None,
            data_dir: layout.root().display().to_string(),
            backup: None,
        };
        Ok(Self {
            layout,
            payload,
            port,
            owner_pubkey: owner_pubkey.to_string(),
            version: version.to_string(),
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                status,
                stopping: false,
                crashes: Vec::new(),
                lock: None,
            })),
            logs: Arc::new(LogBuffer::default()),
        })
    }

    pub fn origin(&self) -> String {
        origin_for(self.port)
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    pub fn status(&self) -> Status {
        let mut inner = self.inner.lock().expect("office lock");
        inner.status.pid = inner.child.as_ref().map(Child::id);
        inner.status.clone()
    }

    pub fn logs(&self) -> Vec<LogLine> {
        self.logs.snapshot()
    }

    /// Say something has gone wrong before the server was ever started —
    /// a locked keychain, say — so the page shows it.
    pub fn fail(&self, message: impl Into<String>) {
        let message = message.into();
        eprintln!("[quintal] office failed: {message}");
        let mut inner = self.inner.lock().expect("office lock");
        inner.status.phase = "failed".into();
        inner.status.message = Some(message);
    }

    /// A line from this side, in the office's log and on this process's
    /// stderr. Both: the page reads the log, and a headless run — CI, a
    /// Console.app session, a bug report — has only the stderr.
    fn note(&self, text: impl Into<String>) {
        let text = text.into();
        eprintln!("[quintal] office: {text}");
        self.logs.push("host", text);
    }

    /// Start the server and keep it running until `stop`.
    ///
    /// `on_ready` is called each time the server answers `/health` — once on
    /// a normal launch, again after a restart — and is where the window is
    /// pointed at the office.
    pub fn start(self: &Arc<Self>, on_ready: impl Fn(&str) + Send + 'static) {
        // The lock first: a second app on the same data directory must not
        // get as far as starting a server.
        match take_lock(&self.layout) {
            Ok(file) => {
                self.inner.lock().expect("office lock").lock = Some(file);
            }
            Err(error) => {
                self.fail(error.to_string());
                return;
            }
        }

        let office = Arc::clone(self);
        std::thread::spawn(move || office.supervise(on_ready));
    }

    fn supervise(self: Arc<Self>, on_ready: impl Fn(&str)) {
        let mut backed_up = false;
        loop {
            if self.inner.lock().expect("office lock").stopping {
                return;
            }

            // A backup before the first attempt of an upgraded version. Once:
            // a crash loop must not fill the disk with copies.
            if !backed_up {
                backed_up = true;
                let record = read_record(&self.layout);
                match backup_before_upgrade(&self.layout, &record, &self.version) {
                    Ok(Some(dir)) => {
                        self.logs.push(
                            "host",
                            format!("backed up the database to {}", dir.display()),
                        );
                        self.inner.lock().expect("office lock").status.backup =
                            Some(dir.display().to_string());
                    }
                    Ok(None) => {}
                    Err(error) => {
                        self.fail(format!(
                            "could not back up the database before upgrading it: {error}"
                        ));
                        return;
                    }
                }
            }

            let secret = match ensure_auth_secret(&self.layout) {
                Ok(secret) => secret,
                Err(error) => {
                    self.fail(error.to_string());
                    return;
                }
            };

            let spawn = plan(&Settings {
                payload: &self.payload,
                layout: &self.layout,
                port: self.port,
                owner_pubkey: &self.owner_pubkey,
            });
            let mut command = Command::new(&spawn.program);
            command
                .args(&spawn.args)
                .current_dir(&spawn.cwd)
                .env_clear()
                .envs(spawn.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
                .env("BETTER_AUTH_SECRET", &secret)
                // Held open, never written: EOF on this pipe is how the server
                // learns the app is gone when no handler ran. See `spawn.rs`.
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            self.note(format!(
                "starting the office on {} (attempt {})",
                self.origin(),
                { self.inner.lock().expect("office lock").status.restarts + 1 }
            ));
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    self.fail(format!(
                        "could not start the office's server ({}): {error}",
                        spawn.program.display()
                    ));
                    return;
                }
            };
            if let Some(out) = child.stdout.take() {
                drain(out, "out", Arc::clone(&self.logs));
            }
            if let Some(err) = child.stderr.take() {
                // Mirrored to this process's stderr as well as kept: the
                // server's complaints are the diagnosis when it will not start,
                // and a headless run has nowhere else to read them.
                drain_mirrored(err, Arc::clone(&self.logs));
            }
            {
                let mut inner = self.inner.lock().expect("office lock");
                inner.child = Some(child);
                inner.status.phase = "starting".into();
                inner.status.message = None;
            }

            // Wait for it to answer, or to die trying.
            let origin = self.origin();
            let health = format!("{origin}/health");
            let started = Instant::now();
            let mut became_ready = false;
            loop {
                if self.exited() {
                    break;
                }
                if healthy(&health) {
                    became_ready = true;
                    break;
                }
                if started.elapsed() > READY_TIMEOUT {
                    self.logs.push(
                        "host",
                        "the office did not answer in time; stopping it".into(),
                    );
                    self.terminate(GRACE);
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }

            if became_ready {
                {
                    let mut inner = self.inner.lock().expect("office lock");
                    inner.status.phase = "ready".into();
                    inner.status.origin = Some(origin.clone());
                }
                // This version has now run migrations and come up: remember
                // it, so the next launch of the same version takes no backup.
                let mut record = read_record(&self.layout);
                if record.version.as_deref() != Some(self.version.as_str()) {
                    record.version = Some(self.version.clone());
                    let _ = write_record(&self.layout, &record);
                }
                on_ready(&origin);

                // Now just watch it.
                while !self.exited() {
                    std::thread::sleep(Duration::from_millis(500));
                }
            }

            // It is gone. Asked to, or on its own?
            let code = self.reap();
            let mut inner = self.inner.lock().expect("office lock");
            if inner.stopping {
                inner.status.phase = "stopped".into();
                inner.status.origin = None;
                return;
            }

            let now = Instant::now();
            inner
                .crashes
                .retain(|at| now.duration_since(*at) < CRASH_WINDOW);
            inner.crashes.push(now);
            let last_words = self.logs.snapshot();
            let tail: Vec<String> = last_words
                .iter()
                .rev()
                .filter(|line| line.stream == "err")
                .take(3)
                .map(|line| line.text.clone())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let why = match code {
                Some(code) => format!("the office's server exited with code {code}"),
                None => "the office's server was killed".to_string(),
            };
            if inner.crashes.len() as u32 > MAX_RESTARTS {
                inner.status.phase = "failed".into();
                inner.status.origin = None;
                inner.status.message = Some(format!(
                    "{why}, and kept doing so. Its last words: {}. Your data is in {}.",
                    if tail.is_empty() {
                        "nothing".to_string()
                    } else {
                        tail.join(" | ")
                    },
                    self.layout.root().display()
                ));
                return;
            }
            inner.status.restarts += 1;
            inner.status.phase = "starting".into();
            inner.status.origin = None;
            inner.status.message = Some(format!("{why}; starting it again"));
            let attempt = inner.status.restarts;
            drop(inner);
            self.logs.push(
                "host",
                format!("{why}; restarting (attempt {})", attempt + 1),
            );
            std::thread::sleep(Duration::from_millis(500 * u64::from(attempt)));
        }
    }

    /// Ask the server to stop, then insist. Safe to call when nothing runs.
    pub fn stop(&self) {
        {
            let mut inner = self.inner.lock().expect("office lock");
            inner.stopping = true;
        }
        self.terminate(GRACE);
        let mut inner = self.inner.lock().expect("office lock");
        inner.status.phase = "stopped".into();
        inner.status.origin = None;
        inner.lock = None;
    }

    fn terminate(&self, grace: Duration) {
        let child = {
            let mut inner = self.inner.lock().expect("office lock");
            inner.child.take()
        };
        let Some(mut child) = child else {
            return;
        };
        interrupt(&child);
        let deadline = Instant::now() + grace;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }

    fn exited(&self) -> bool {
        let mut inner = self.inner.lock().expect("office lock");
        match inner.child.as_mut() {
            Some(child) => !matches!(child.try_wait(), Ok(None)),
            None => true,
        }
    }

    /// Collect the exit code of a child that has ended, and forget it.
    fn reap(&self) -> Option<i32> {
        let mut inner = self.inner.lock().expect("office lock");
        let child = inner.child.take()?;
        let mut child = child;
        child.wait().ok().and_then(|status| status.code())
    }
}

/// Pump the server's stderr into the log and onto ours.
fn drain_mirrored<R: std::io::Read + Send + 'static>(pipe: R, logs: Arc<LogBuffer>) {
    use std::io::{BufRead, BufReader};
    std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines() {
            match line {
                Ok(text) => {
                    eprintln!("[quintal] office server: {text}");
                    logs.push("err", text);
                }
                Err(_) => break,
            }
        }
    });
}

/// One process per office. The lock file is held open for as long as the
/// server runs; the OS releases it if this process dies.
fn take_lock(layout: &Layout) -> Result<std::fs::File, PersonalError> {
    use fs4::fs_std::FileExt;
    std::fs::create_dir_all(layout.root())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(layout.lock())?;
    match file.try_lock_exclusive() {
        Ok(true) => Ok(file),
        _ => Err(PersonalError::AlreadyRunning),
    }
}

/// Is the server answering? A real request, not a TCP connect: the port
/// being open means Node is up, not that migrations ran and Next is ready.
fn healthy(url: &str) -> bool {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(1500))
        .build()
        .get(url)
        .call()
        .map(|response| response.status() == 200)
        .unwrap_or(false)
}

fn interrupt(child: &Child) {
    #[cfg(unix)]
    {
        // SIGTERM, which the server handles by shutting Colyseus down and
        // closing the database. Safe: a pid this process owns.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> (tempfile::TempDir, Layout) {
        let dir = tempfile::tempdir().expect("tempdir");
        let layout = Layout::under(dir.path());
        (dir, layout)
    }

    fn fake_payload(dir: &Path) -> Payload {
        Payload {
            node: dir.join("node"),
            entry: dir.join("entry.js"),
            web_dir: dir.join("web"),
            manifest: Manifest::default(),
        }
    }

    #[test]
    fn the_port_is_never_3000_and_never_privileged() {
        for _ in 0..50 {
            let port = choose_port(None).expect("a port");
            assert_ne!(port, RESERVED_PORT);
            assert!(port >= 1024);
        }
        // Asking for 3000 explicitly is refused too — that is the one every
        // developer's other project is on.
        let port = choose_port(Some(RESERVED_PORT)).expect("a port");
        assert_ne!(port, RESERVED_PORT);
        assert_ne!(choose_port(Some(80)).expect("a port"), 80);
    }

    #[test]
    fn a_free_preferred_port_is_kept_so_the_address_stays_put() {
        let free = {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.local_addr().unwrap().port()
        };
        if free != RESERVED_PORT {
            assert_eq!(choose_port(Some(free)).expect("a port"), free);
        }
    }

    #[test]
    fn a_taken_preferred_port_yields_another_rather_than_failing() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = held.local_addr().unwrap().port();
        let chosen = choose_port(Some(taken)).expect("a port");
        assert_ne!(chosen, taken);
    }

    #[test]
    fn the_origin_is_ipv4_loopback() {
        assert_eq!(origin_for(43117), "http://127.0.0.1:43117");
        assert!(crate::server::is_usable_server(&origin_for(43117)));
    }

    #[test]
    fn the_secret_is_minted_once_and_kept_private() {
        let (_dir, layout) = layout();
        let first = ensure_auth_secret(&layout).expect("a secret");
        assert!(first.len() >= 32);
        assert_eq!(ensure_auth_secret(&layout).expect("again"), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(layout.auth_secret())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "nobody else on the machine reads it");
        }
    }

    #[test]
    fn a_too_short_secret_on_disk_is_replaced_and_made_private() {
        let (_dir, layout) = layout();
        std::fs::create_dir_all(layout.root()).unwrap();
        std::fs::write(layout.auth_secret(), "short\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // A stub anybody on the machine could read. Replacing its contents
            // must not leave its permissions behind.
            std::fs::set_permissions(layout.auth_secret(), std::fs::Permissions::from_mode(0o644))
                .unwrap();
        }
        assert!(ensure_auth_secret(&layout).unwrap().len() >= 32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(layout.auth_secret())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn the_record_is_created_once_with_a_stable_id() {
        let (_dir, layout) = layout();
        let first = load_or_create_record(&layout).unwrap();
        assert_eq!(first.id.len(), 32);
        assert_eq!(load_or_create_record(&layout).unwrap().id, first.id);
    }

    /// Nothing about where data goes may come from the shell, and no secret
    /// may appear anywhere a debug print could reach.
    #[test]
    fn the_plan_pins_loopback_the_data_directory_and_the_owner_and_carries_no_secret() {
        let (dir, layout) = layout();
        let payload = fake_payload(dir.path());
        let spawn = plan(&Settings {
            payload: &payload,
            layout: &layout,
            port: 43117,
            owner_pubkey: &"ab".repeat(32),
        });
        let env: std::collections::HashMap<_, _> = spawn.env.iter().cloned().collect();
        assert_eq!(env["HOST"], "127.0.0.1");
        assert_eq!(env["PORT"], "43117");
        assert_eq!(env["NODE_ENV"], "production");
        assert_eq!(env["BETTER_AUTH_URL"], "http://127.0.0.1:43117");
        assert_eq!(
            env["DATABASE_URL"],
            format!("file:{}", layout.db().display())
        );
        assert_eq!(
            env["STORAGE_URL"],
            format!("file:{}", layout.objects().display())
        );
        assert_eq!(env["STORAGE_ALLOW_LOCAL"], "1");
        assert_eq!(env["QUINTAL_PERSONAL_OWNER"], "ab".repeat(32));
        assert_eq!(
            env["QUINTAL_EXIT_WITH_PARENT"], "1",
            "an orphaned server must stop itself"
        );
        assert_eq!(
            env["QUINTAL_WEB_DIR"],
            payload.web_dir.display().to_string()
        );
        assert!(
            !env.contains_key("BETTER_AUTH_SECRET"),
            "applied at spawn, never planned"
        );
        assert_eq!(spawn.program, payload.node);
        assert_eq!(spawn.args, vec![payload.entry.display().to_string()]);
        let rendered = format!("{spawn:?}");
        assert!(!rendered.contains("SECRET"));
    }

    #[test]
    fn a_backup_is_taken_when_the_version_changes_and_not_otherwise() {
        let (_dir, layout) = layout();
        std::fs::create_dir_all(layout.root()).unwrap();
        std::fs::write(layout.db(), b"sqlite bytes").unwrap();
        std::fs::write(format!("{}-wal", layout.db().display()), b"wal").unwrap();

        let record = Record {
            version: Some("0.4.0".into()),
            ..Record::default()
        };
        let taken = backup_before_upgrade(&layout, &record, "0.5.0")
            .unwrap()
            .expect("a backup");
        assert!(taken.join("quintal.db").is_file());
        assert!(taken.join("quintal.db-wal").is_file());
        assert!(taken
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("-0.4.0-to-0.5.0"));

        let same = Record {
            version: Some("0.5.0".into()),
            ..Record::default()
        };
        assert!(backup_before_upgrade(&layout, &same, "0.5.0")
            .unwrap()
            .is_none());
    }

    #[test]
    fn nothing_is_backed_up_before_there_is_a_database() {
        let (_dir, layout) = layout();
        assert!(backup_before_upgrade(&layout, &Record::default(), "0.5.0")
            .unwrap()
            .is_none());
        assert!(!layout.backups().exists());
    }

    #[test]
    fn only_the_newest_backups_are_kept() {
        let (_dir, layout) = layout();
        std::fs::create_dir_all(layout.root()).unwrap();
        std::fs::write(layout.db(), b"sqlite bytes").unwrap();
        for i in 0..(BACKUPS_KEPT + 3) {
            let record = Record {
                version: Some(format!("0.{i}.0")),
                ..Record::default()
            };
            backup_before_upgrade(&layout, &record, "9.9.9").unwrap();
            // Distinct stamps: the name is second-resolution.
            std::thread::sleep(Duration::from_millis(1100 / (BACKUPS_KEPT as u64 + 3)));
        }
        let kept = std::fs::read_dir(layout.backups()).unwrap().count();
        assert!(kept <= BACKUPS_KEPT, "kept {kept}");
    }

    #[test]
    fn the_lock_admits_one_office_at_a_time() {
        let (_dir, layout) = layout();
        let first = take_lock(&layout).expect("first lock");
        assert!(matches!(
            take_lock(&layout),
            Err(PersonalError::AlreadyRunning)
        ));
        drop(first);
        take_lock(&layout).expect("free again");
    }

    #[test]
    fn a_missing_payload_is_named_rather_than_guessed() {
        let dir = tempfile::tempdir().unwrap();
        let error = locate_payload(Some(dir.path()), Some(dir.path())).expect_err("no payload");
        assert!(matches!(error, PersonalError::NoPayload(_)), "{error}");
    }

    #[test]
    fn a_payload_without_a_runtime_beside_the_app_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("personal");
        std::fs::create_dir_all(payload.join("node_modules/@quintal/server/dist")).unwrap();
        std::fs::write(
            payload.join("node_modules/@quintal/server/dist/index.js"),
            "",
        )
        .unwrap();
        std::fs::write(payload.join("payload.json"), "{}").unwrap();
        let exe_dir = dir.path().join("bin");
        std::fs::create_dir_all(&exe_dir).unwrap();
        assert!(matches!(
            locate_payload(Some(dir.path()), Some(&exe_dir)),
            Err(PersonalError::NoRuntime)
        ));

        std::fs::write(
            exe_dir.join(if cfg!(windows) {
                "quintal-node.exe"
            } else {
                "quintal-node"
            }),
            "",
        )
        .unwrap();
        let found = locate_payload(Some(dir.path()), Some(&exe_dir)).expect("found");
        assert_eq!(
            found.entry,
            payload.join("node_modules/@quintal/server/dist/index.js")
        );
        assert_eq!(found.web_dir, payload.join("node_modules/@quintal/web"));
    }

    #[test]
    fn the_stamp_reads_as_a_utc_date() {
        let stamp = now_stamp();
        assert_eq!(stamp.len(), 15, "{stamp}");
        assert!(stamp.starts_with("20"));
    }

    /// The supervisor, against a stand-in server: a shell script that answers
    /// `/health` is more than this needs, so the fake exits with a code and
    /// the test watches the restart budget run out.
    #[cfg(unix)]
    #[test]
    fn a_server_that_keeps_dying_is_given_up_on_with_its_last_words() {
        use std::os::unix::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let node = dir.path().join("node");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o755)
            .open(&node)
            .unwrap();
        writeln!(
            file,
            "#!/bin/sh\necho 'migration failed: no such column' >&2\nexit 7"
        )
        .unwrap();
        drop(file);
        let entry = dir.path().join("entry.js");
        std::fs::write(&entry, "").unwrap();

        let payload = Payload {
            node,
            entry,
            web_dir: dir.path().join("web"),
            manifest: Manifest::default(),
        };
        let office = Arc::new(
            Office::prepare(dir.path(), payload, &"ab".repeat(32), "0.5.0").expect("prepared"),
        );
        office.start(|_| panic!("a server that exits at once is never ready"));

        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let status = office.status();
            if status.phase == "failed" {
                assert!(status.restarts >= MAX_RESTARTS, "{status:?}");
                let message = status.message.unwrap();
                assert!(message.contains("code 7"), "{message}");
                assert!(message.contains("migration failed"), "{message}");
                assert!(message.contains(&dir.path().join(PERSONAL).display().to_string()));
                break;
            }
            assert!(Instant::now() < deadline, "never gave up: {status:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
        office.stop();
    }
}
