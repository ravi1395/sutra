//! Cross-process window registry: one live process per canonical root.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use sysinfo::{Pid, ProcessesToUpdate, System};

/// Canonical key (lowercased realpath) plus the original-case realpath, in one
/// canonicalize call. The key is the cross-process identity (APFS is
/// case-insensitive); the real path is what filesystem ops (MCP teardown,
/// endpoint) must use — case-sensitive volumes silently no-op on a lowercased
/// path that doesn't exist.
pub fn canonical_root(path: &str) -> Result<(String, String), String> {
    let real = std::fs::canonicalize(Path::new(path)).map_err(|e| e.to_string())?;
    let real_str = real.to_string_lossy().into_owned();
    Ok((real_str.to_lowercase(), real_str))
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
    pub root: String,      // canonical (lowercased) key, or "untitled:<uuid>" — identity
    #[serde(default)]
    pub real_root: String, // original-case realpath — use for all filesystem ops
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

static CLAIM_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A per-attempt unique path in `registry_dir()` — pid + a process-local
/// atomic counter, never `Date`/`rand`, so two threads/processes never collide.
fn tmp_path(root_key: &str) -> PathBuf {
    let n = CLAIM_COUNTER.fetch_add(1, Ordering::Relaxed);
    registry_dir().join(format!("{}.{}.{}.tmp", root_hash(root_key), std::process::id(), n))
}

/// Atomically claim `root_key`. The lock's full JSON is written to a unique
/// temp file first, then published via `hard_link` — which fails with
/// `AlreadyExists` if the destination is already occupied and otherwise
/// creates it already fully populated. The destination path can therefore
/// never be observed empty or partially written, closing the TOCTOU where a
/// racer read an in-progress file as garbage and deleted it out from under
/// the real owner (both racers then return `Won`).
///
/// If the destination exists: a live owner → `Owned`; a confirmed-dead owner
/// (pid/start/exe mismatch) → remove and retry; an unreadable/unparseable
/// file (contention mid-publish, or corruption) is NEVER deleted — we back
/// off and retry, and if it never resolves we hand back a best-effort/benign
/// `Owned` rather than risk a second `Won`. Losing a race (exit) is always
/// safer than creating two owners.
pub fn try_claim(root_key: &str, mk: impl FnOnce() -> Lock) -> std::io::Result<ClaimResult> {
    let path = lock_path(root_key);
    let lock = mk();
    let bytes = serde_json::to_vec(&lock).unwrap();

    for attempt in 0..10u32 {
        let tmp = tmp_path(root_key);
        std::fs::write(&tmp, &bytes)?;
        match std::fs::hard_link(&tmp, &path) {
            Ok(()) => {
                let _ = std::fs::remove_file(&tmp);
                return Ok(ClaimResult::Won);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let _ = std::fs::remove_file(&tmp);
                match read_lock(&path) {
                    Some(existing) if is_live(&existing) => return Ok(ClaimResult::Owned(existing)),
                    Some(_dead) => {
                        // Confirmed dead (pid/start/exe mismatch) — safe to reclaim.
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    None => {
                        // Unreadable: with hard_link this means another claimer's
                        // publish landed between our AlreadyExists and our read (or
                        // it vanished via a concurrent dead-reclaim). Never delete;
                        // back off briefly and retry — the path may already be free.
                        std::thread::sleep(Duration::from_millis(5 * (attempt as u64 + 1)));
                        continue;
                    }
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
    // Exhausted retries under sustained contention. Never fabricate a `Won`
    // here — re-read once more; if the path is still unreadable, hand back a
    // benign, non-connectable `Owned` so the caller loses the race (exits)
    // instead of risking a second owner.
    match read_lock(&path) {
        Some(existing) => Ok(ClaimResult::Owned(existing)),
        None => Ok(ClaimResult::Owned(Lock {
            pid: 0,
            process_start: 0,
            exe: String::new(),
            focus_port: 0,
            token: String::new(),
            root: root_key.to_string(),
            real_root: String::new(),
        })),
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

/// Overwrite a claimed root's lockfile atomically (temp + rename). No longer
/// called on the boot path (the claim now publishes the real port/token from
/// creation — Important-1), but kept and covered by `write_lock_overwrites`
/// for any future need to update a live lock's contents in place.
#[allow(dead_code)]
pub fn write_lock(root_key: &str, lock: &Lock) -> std::io::Result<()> {
    let path = lock_path(root_key);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(lock)?)?;
    std::fs::rename(tmp, path)
}

/// Per-root WebKit data-store id: first 16 bytes of `sha256(root_key)`, used to
/// isolate each window's `localStorage`/cookies (macOS `data_store_identifier`).
pub fn data_store_id(root_key: &str) -> [u8; 16] {
    let h = root_hash(root_key);
    let mut out = [0u8; 16];
    out.copy_from_slice(&hex::decode(&h[..32]).expect("sha256 hex is valid"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_key_is_lowercased_realpath() {
        // A tempdir exists on disk so canonicalize succeeds.
        let dir = std::env::temp_dir().join("SutraKeyTest_UPPER");
        std::fs::create_dir_all(&dir).unwrap();
        let (key, real) = canonical_root(dir.to_str().unwrap()).unwrap();
        assert_eq!(key, key.to_lowercase(), "key must be case-folded");
        assert!(key.contains("sutrakeytest_upper"), "got {key}");
        assert!(real.contains("SutraKeyTest_UPPER"), "real_root keeps original case: {real}");
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
            real_root: "/tmp/x".into(),
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
            real_root: "/tmp/x".into(),
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
            real_root: key.clone(),
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
            real_root: key.clone(),
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
            real_root: key.clone(),
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
                real_root: key.clone(),
            })
            .unwrap(),
            ClaimResult::Won
        );
        assert!(won, "dead owner must be reclaimed");
        release(&key);
    }

    #[test]
    fn data_store_id_is_deterministic_and_16_bytes() {
        let a = data_store_id("some-root");
        let b = data_store_id("some-root");
        assert_eq!(a, b, "same key must yield same data store id");
        assert_eq!(a.len(), 16);
        let c = data_store_id("other-root");
        assert_ne!(a, c, "different keys must yield different ids");
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
            real_root: key.clone(),
        };
        write_lock(&key, &l).unwrap();
        assert_eq!(live_owner(&key).unwrap().focus_port, 42);
        release(&key);
    }

    /// The concurrency test the original suite lacked: N threads race
    /// `try_claim` on the SAME fresh key, released together via a barrier so
    /// they contend at the same instant. Exactly one must win; this is the
    /// exact race the pre-fix `create_new`+`write_all` two-step allowed both
    /// sides of to return `Won` (empty-file TOCTOU, Critical-1).
    #[test]
    fn concurrent_claims_exactly_one_wins() {
        let key = format!(
            "concurrent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let _ = release(&key);
        let (pid, start, exe) = self_identity();
        const N: usize = 8;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(N));
        let handles: Vec<_> = (0..N)
            .map(|i| {
                let key = key.clone();
                let exe = exe.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait(); // release all N at the same instant
                    try_claim(&key, || Lock {
                        pid,
                        process_start: start,
                        exe: exe.clone(),
                        focus_port: 1000 + i as u16,
                        token: format!("t{i}"),
                        root: key.clone(),
                        real_root: key.clone(),
                    })
                })
            })
            .collect();
        let results: Vec<ClaimResult> =
            handles.into_iter().map(|h| h.join().unwrap().unwrap()).collect();
        let won = results.iter().filter(|r| matches!(r, ClaimResult::Won)).count();
        let owned = results.iter().filter(|r| matches!(r, ClaimResult::Owned(_))).count();
        assert_eq!(won, 1, "exactly one of {N} concurrent claimers must win, got {won}");
        assert_eq!(owned, N - 1, "all others must see Owned, got {owned}");
        release(&key);
    }
}
