//! Cross-process window registry: one live process per canonical root.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use sysinfo::{Pid, ProcessesToUpdate, System};

/// Canonical key for a root: resolved realpath, case-folded (APFS is
/// case-insensitive). This is the identity two launches compare on.
pub fn canonical_root_key(path: &str) -> Result<String, String> {
    let real = std::fs::canonicalize(Path::new(path)).map_err(|e| e.to_string())?;
    Ok(real.to_string_lossy().to_lowercase())
}

/// Hex sha256 of a key — the registry lockfile stem.
pub fn root_hash(key: &str) -> String {
    let mut h = Sha256::new();
    h.update(key.as_bytes());
    format!("{:x}", h.finalize())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Lock {
    pub pid: u32,
    pub process_start: u64, // seconds since epoch, from sysinfo
    pub exe: String,
    pub focus_port: u16,
    pub token: String,
    pub root: String, // canonical key, or "untitled:<uuid>"
}

/// `~/Library/Application Support/com.ravi1395.sutra/windows/`
pub fn registry_dir() -> PathBuf {
    let base = dirs_app_support().join("com.ravi1395.sutra").join("windows");
    let _ = std::fs::create_dir_all(&base);
    base
}

fn dirs_app_support() -> PathBuf {
    // macOS: ~/Library/Application Support ; fallback to home/.local/share
    if let Some(home) = std::env::var_os("HOME") {
        let mac = PathBuf::from(&home).join("Library").join("Application Support");
        if cfg!(target_os = "macos") {
            return mac;
        }
        return PathBuf::from(home).join(".local").join("share");
    }
    std::env::temp_dir()
}

/// (pid, start_time_secs, exe_path) for the current process.
pub fn self_identity() -> (u32, u64, String) {
    let pid = std::process::id();
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let (start, exe) = sys
        .process(Pid::from_u32(pid))
        .map(|p| {
            (
                p.start_time(),
                p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default(),
            )
        })
        .unwrap_or((0, String::new()));
    (pid, start, exe)
}

/// A lock is live iff pid exists AND its start-time and exe match the record.
pub fn is_live(lock: &Lock) -> bool {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    match sys.process(Pid::from_u32(lock.pid)) {
        Some(p) => {
            let exe = p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
            p.start_time() == lock.process_start && exe == lock.exe
        }
        None => false,
    }
}

pub enum ClaimResult {
    Won,
    Owned(Lock),
}

fn lock_path(root_key: &str) -> PathBuf {
    registry_dir().join(format!("{}.json", root_hash(root_key)))
}

/// Atomically claim `root_key`. Creates the lockfile with O_EXCL so exactly
/// one racer wins. If it already exists: live owner → Owned; dead owner →
/// remove and retry the exclusive create. Bounded retry avoids livelock.
pub fn try_claim(root_key: &str, mk: impl FnOnce() -> Lock) -> std::io::Result<ClaimResult> {
    let path = lock_path(root_key);
    let lock = mk();
    let bytes = serde_json::to_vec(&lock).unwrap();
    for _ in 0..5 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                f.write_all(&bytes)?;
                return Ok(ClaimResult::Won);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                match read_lock(&path) {
                    Some(existing) if is_live(&existing) => return Ok(ClaimResult::Owned(existing)),
                    _ => {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    } // dead/garbage → reclaim
                }
            }
            Err(e) => return Err(e),
        }
    }
    // Lost every reclaim race to a live winner: report it as owner.
    match read_lock(&path) {
        Some(existing) => Ok(ClaimResult::Owned(existing)),
        None => std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .and_then(|mut f| {
                f.write_all(&bytes)?;
                Ok(ClaimResult::Won)
            }),
    }
}

fn read_lock(path: &Path) -> Option<Lock> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The live owner of `root_key`, if any (warm-caller lookup, no claim).
pub fn live_owner(root_key: &str) -> Option<Lock> {
    read_lock(&lock_path(root_key)).filter(is_live)
}

/// Remove our own lockfile on graceful close.
pub fn release(root_key: &str) {
    let _ = std::fs::remove_file(lock_path(root_key));
}

/// Delete every dead lockfile; return the reclaimed locks so the caller can
/// heal their stale MCP config (Phase 3). Any launch heals all crashed roots.
pub fn gc_sweep() -> Vec<Lock> {
    let mut reclaimed = Vec::new();
    let dir = registry_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Some(l) = read_lock(&p) {
                if !is_live(&l) {
                    let _ = std::fs::remove_file(&p);
                    reclaimed.push(l);
                }
            }
        }
    }
    reclaimed
}

/// Overwrite a claimed root's lockfile atomically (temp + rename).
pub fn write_lock(root_key: &str, lock: &Lock) -> std::io::Result<()> {
    let path = lock_path(root_key);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(lock)?)?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_key_is_lowercased_realpath() {
        // A tempdir exists on disk so canonicalize succeeds.
        let dir = std::env::temp_dir().join("SutraKeyTest_UPPER");
        std::fs::create_dir_all(&dir).unwrap();
        let key = canonical_root_key(dir.to_str().unwrap()).unwrap();
        assert_eq!(key, key.to_lowercase(), "key must be case-folded");
        assert!(key.contains("sutrakeytest_upper"), "got {key}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn root_hash_is_stable_hex() {
        let a = root_hash("/tmp/x");
        let b = root_hash("/tmp/x");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64, "sha256 hex is 64 chars");
    }

    #[test]
    fn dead_pid_is_not_live() {
        // pid 999999 is (essentially) never alive on macOS/Linux CI.
        let lock = Lock {
            pid: 999_999,
            process_start: 1,
            exe: "/nope".into(),
            focus_port: 0,
            token: "t".into(),
            root: "/tmp/x".into(),
        };
        assert!(!is_live(&lock));
    }

    #[test]
    fn self_is_live_but_start_mismatch_is_not() {
        let (pid, start, exe) = self_identity();
        let good = Lock {
            pid,
            process_start: start,
            exe: exe.clone(),
            focus_port: 0,
            token: "t".into(),
            root: "/tmp/x".into(),
        };
        assert!(is_live(&good), "own process must read as live");
        let stale = Lock {
            process_start: start.wrapping_add(1),
            ..good.clone()
        };
        assert!(!is_live(&stale), "pid-reuse (start mismatch) must read dead");
    }

    #[test]
    fn claim_wins_then_second_sees_owned() {
        let key = format!("claimtest-{}", std::process::id());
        let _ = release(&key);
        let (pid, start, exe) = self_identity();
        let mk = || Lock {
            pid,
            process_start: start,
            exe: exe.clone(),
            focus_port: 5,
            token: "tok".into(),
            root: key.clone(),
        };
        match try_claim(&key, mk).unwrap() {
            ClaimResult::Won => {}
            ClaimResult::Owned(_) => panic!("first claim must win"),
        }
        // second claim by "another" launch: our own pid is live → Owned.
        match try_claim(&key, || Lock {
            pid,
            process_start: start,
            exe: exe.clone(),
            focus_port: 9,
            token: "x".into(),
            root: key.clone(),
        })
        .unwrap()
        {
            ClaimResult::Owned(l) => assert_eq!(l.focus_port, 5, "sees original owner"),
            ClaimResult::Won => panic!("second must not win a live root"),
        }
        release(&key);
    }

    #[test]
    fn stale_lock_is_reclaimed() {
        let key = format!("stale-{}", std::process::id());
        let _ = release(&key);
        // Plant a dead lock directly.
        let dead = Lock {
            pid: 999_999,
            process_start: 1,
            exe: "/nope".into(),
            focus_port: 1,
            token: "d".into(),
            root: key.clone(),
        };
        let path = registry_dir().join(format!("{}.json", root_hash(&key)));
        std::fs::write(&path, serde_json::to_string(&dead).unwrap()).unwrap();
        let (pid, start, exe) = self_identity();
        let won = matches!(
            try_claim(&key, || Lock {
                pid,
                process_start: start,
                exe: exe.clone(),
                focus_port: 7,
                token: "n".into(),
                root: key.clone(),
            })
            .unwrap(),
            ClaimResult::Won
        );
        assert!(won, "dead owner must be reclaimed");
        release(&key);
    }

    #[test]
    fn write_lock_overwrites() {
        let key = format!("wl-{}", std::process::id());
        let (pid, start, exe) = self_identity();
        let l = Lock {
            pid,
            process_start: start,
            exe,
            focus_port: 42,
            token: "T".into(),
            root: key.clone(),
        };
        write_lock(&key, &l).unwrap();
        assert_eq!(live_owner(&key).unwrap().focus_port, 42);
        release(&key);
    }
}
