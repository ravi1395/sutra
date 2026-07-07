//! Cross-process window registry: one live process per canonical root.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Per-root advisory-lock mutex file. Persistent and reusable (never
/// removed) — `gc_sweep` only scans `.json`, so it never touches this.
fn guard_path(root_key: &str) -> PathBuf {
    registry_dir().join(format!("{}.guard", root_hash(root_key)))
}

static CLAIM_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A per-attempt unique path in `registry_dir()` — pid + a process-local
/// atomic counter, never `Date`/`rand`, so two threads/processes never collide.
fn tmp_path(root_key: &str) -> PathBuf {
    let n = CLAIM_COUNTER.fetch_add(1, Ordering::Relaxed);
    registry_dir().join(format!("{}.{}.{}.tmp", root_hash(root_key), std::process::id(), n))
}

/// Write `lock`'s full JSON to a unique tmp file, then atomically place it at
/// `dest` via `rename` (same-filesystem, POSIX-atomic). The tmp is removed on
/// every path — success, rename failure, or write failure — so a failed
/// publish never leaks a `<hash>.<pid>.<n>.tmp` into `registry_dir()`.
fn publish_atomic(root_key: &str, dest: &Path, lock: &Lock) -> io::Result<()> {
    let tmp = tmp_path(root_key);
    let write_result = std::fs::write(&tmp, serde_json::to_vec(lock).unwrap());
    let result = write_result.and_then(|()| std::fs::rename(&tmp, dest));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Acquire an exclusive advisory `flock` on `guard_path` (creating it if
/// absent), run `f` while holding it, then release when the returned guard
/// `File` drops (fd close) at the end of this call — including on panic
/// unwind or process death, so there's never an orphaned sentinel.
///
/// `flock` is per-open-file-description: each `OpenOptions::open` call
/// (thread or process) gets its own fd/description, so two threads of one
/// process serialize on the guard exactly like two processes do — confirmed
/// by `concurrent_claims_exactly_one_wins` and `concurrent_reclaim_exactly_one_wins`,
/// both of which race threads, not processes.
///
/// Shared by `try_claim` and `gc_sweep` so both serialize against each other
/// on the SAME per-root guard file, not just against themselves.
fn with_root_guard<T>(guard_path: &Path, f: impl FnOnce() -> T) -> io::Result<T> {
    let guard = OpenOptions::new().read(true).write(true).create(true).open(guard_path)?;
    let fd = guard.as_raw_fd();
    // SAFETY: `fd` is a valid, open file descriptor owned by `guard` for the
    // duration of this call; `flock` only reads/blocks on it.
    let rc = unsafe { libc::flock(fd, libc::LOCK_EX) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    let result = f();
    // `guard` drops here — flock released (fd close), including on panic
    // unwind or process death.
    Ok(result)
}

/// Claim `root_key`, serialized against every other thread/process racing the
/// same root via an advisory exclusive `flock` on a per-root `.guard` file
/// (see `with_root_guard`).
///
/// Readers (`live_owner`) never take this lock — they must keep working
/// lock-free — so the published lockfile must always be a *complete* file.
/// That is `publish_atomic`'s job (tmp write + `rename`, never observed
/// empty or partial). What `flock` buys is mutual exclusion of the
/// *read-decide-publish* sequence itself: the prior fix (atomic `hard_link`
/// publish) closed the empty-file TOCTOU for a fresh key, but the dead-lock
/// reclaim arm still read-then-`remove_file`-by-name, so two racers could
/// both decide "dead" from their own read, and the second one's
/// `remove_file` would delete the first one's freshly-published *live* lock
/// out from under it — two `Won` for one root (NEW-1). Holding the guard
/// across the entire decide+remove+publish sequence means only one
/// thread/process is ever inside that sequence for a given root at a time;
/// everyone else either blocks or (after acquiring) re-reads and sees the
/// live winner.
///
/// `gc_sweep` acquires this SAME guard file before removing a dead lock
/// (NEW-4) — so a `gc_sweep` mid-decide for this root and a `try_claim` for
/// it can never interleave; whichever gets the guard first runs its whole
/// read-decide-mutate sequence to completion before the other even reads.
pub fn try_claim(root_key: &str, mk: impl FnOnce() -> Lock) -> io::Result<ClaimResult> {
    let dest = lock_path(root_key);
    with_root_guard(&guard_path(root_key), || -> io::Result<ClaimResult> {
        // ---- critical section: only one thread/process per root here ----
        match read_lock(&dest) {
            Some(existing) if is_live(&existing) => Ok(ClaimResult::Owned(existing)),
            _ => {
                // Absent, confirmed dead, or corrupt: we hold the guard, so no
                // concurrent writer (incl. gc_sweep) can be mid-decide/mutate
                // — safe to clear and take it.
                let _ = std::fs::remove_file(&dest);
                publish_atomic(root_key, &dest, &mk())?;
                Ok(ClaimResult::Won)
            }
        }
    })?
}

fn read_lock(path: &Path) -> Option<Lock> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The live owner of `root_key`, if any (warm-caller lookup, no claim).
pub fn live_owner(root_key: &str) -> Option<Lock> {
    read_lock(&lock_path(root_key)).filter(is_live)
}

/// Remove our own lockfile on graceful close — but only if it still
/// identifies THIS process. An unconditional remove would let the first
/// quitter of two same-root processes delete the survivor's lock out from
/// under it (the failure mode CRITICAL-1 named); checking pid/start/exe
/// against `self_identity()` first means we only ever delete a lock we
/// ourselves published or still occupy.
pub fn release(root_key: &str) {
    let path = lock_path(root_key);
    let (pid, start, exe) = self_identity();
    if let Some(l) = read_lock(&path) {
        if l.pid == pid && l.process_start == start && l.exe == exe {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Delete every dead lockfile; return the reclaimed locks so the caller can
/// heal their stale MCP config (Phase 3). Any launch heals all crashed roots.
///
/// NEW-4 fix: a per-root `remove_file`-by-name with no guard raced
/// `try_claim`'s publish — `gc_sweep` could read a stale dead lock for root
/// R, then `try_claim(R)` reclaims and publishes a fresh LIVE lock at the
/// same path, then `gc_sweep`'s now-stale decision deletes that live lock →
/// R goes unowned while its process is live → next launch mints a second
/// owner. Fixed by acquiring the SAME per-root `.guard` `try_claim` locks
/// (`p.with_extension("guard")` on a `<hash>.json` path yields the identical
/// `<hash>.guard` file `guard_path` derives) and RE-VALIDATING liveness
/// inside the guard before removing — symmetric to `try_claim`'s own
/// reclaim arm. If the guard can't be acquired, skip the entry (fail safe:
/// never remove without the guard).
pub fn gc_sweep() -> Vec<Lock> {
    let mut reclaimed = Vec::new();
    let dir = registry_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let gp = p.with_extension("guard");
            let outcome = with_root_guard(&gp, || {
                // Re-read + re-validate INSIDE the guard: a racer may have
                // reclaimed and republished a live lock at `p` since our
                // caller-less initial scan, or removed it already.
                match read_lock(&p) {
                    Some(l) if !is_live(&l) => {
                        let _ = std::fs::remove_file(&p);
                        Some(l)
                    }
                    _ => None,
                }
            });
            if let Ok(Some(l)) = outcome {
                reclaimed.push(l);
            }
            // Err (guard acquisition failed) or Ok(None) (now-live or gone):
            // skip this entry, never remove.
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

    /// NEW-1 regression: plant a DEAD lock (simulated crash), then race N
    /// threads through the reclaim arm of `try_claim` on the SAME key via a
    /// barrier. Pre-fix, two racers could each read the dead lock, both
    /// decide "reclaim", and the second's `remove_file`-by-name would delete
    /// the first's freshly-published *live* lock — yielding two `Won`. The
    /// `flock` guard serializes read-decide-publish, so exactly one must win
    /// and every other thread must re-read the winner's live lock as `Owned`.
    #[test]
    fn concurrent_reclaim_exactly_one_wins() {
        let key = format!(
            "reclaim-race-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let _ = release(&key);
        // Plant a dead lock directly (simulated crash: pid/start/exe never match).
        let dead = Lock {
            pid: 999_999,
            process_start: 1,
            exe: "/nope".into(),
            focus_port: 1,
            token: "d".into(),
            root: key.clone(),
            real_root: key.clone(),
        };
        std::fs::write(&lock_path(&key), serde_json::to_string(&dead).unwrap()).unwrap();

        let (pid, start, exe) = self_identity();
        const N: usize = 8;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(N));
        let handles: Vec<_> = (0..N)
            .map(|i| {
                let key = key.clone();
                let exe = exe.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait(); // release all N at the same instant into the reclaim arm
                    try_claim(&key, || Lock {
                        pid,
                        process_start: start,
                        exe: exe.clone(),
                        focus_port: 2000 + i as u16,
                        token: format!("r{i}"),
                        root: key.clone(),
                        real_root: key.clone(),
                    })
                })
            })
            .collect();
        let results: Vec<ClaimResult> =
            handles.into_iter().map(|h| h.join().unwrap().unwrap()).collect();
        let won = results.iter().filter(|r| matches!(r, ClaimResult::Won)).count();
        let owned_ports: Vec<u16> = results
            .iter()
            .filter_map(|r| match r {
                ClaimResult::Owned(l) => Some(l.focus_port),
                ClaimResult::Won => None,
            })
            .collect();
        assert_eq!(won, 1, "exactly one reclaimer of {N} must win a stale root, got {won}");
        assert_eq!(owned_ports.len(), N - 1, "all others must see Owned, got {}", owned_ports.len());
        // Every loser's Owned must be a REAL live lock (never a synthesized
        // port-0 placeholder — NEW-2), and it must be the actual winner
        // (whichever port that turned out to be), never the dead lock (1) or
        // a fabricated 0.
        for p in &owned_ports {
            assert!(*p >= 2000, "Owned must carry the real winning lock, got port {p}");
        }
        let distinct: std::collections::HashSet<u16> = owned_ports.into_iter().collect();
        assert_eq!(distinct.len(), 1, "all losers must observe the SAME single winner");
        release(&key);
    }

    /// NEW-4 regression: `gc_sweep`'s per-root remove-by-name must never race
    /// ahead of a concurrent `try_claim` reclaiming the SAME root and delete
    /// the freshly-published LIVE lock. Pre-fix, `gc_sweep` read-decided
    /// "dead" against a stale read, then removed by path with no guard; if
    /// `try_claim` reclaimed and republished a live lock at that path in
    /// between, `gc_sweep`'s stale decision deleted the live lock, leaving
    /// the root falsely unowned (next launch mints a second owner). Looped
    /// 50x because the interleave is timing-dependent — a single run could
    /// pass even with the bug present if the thread scheduler happened not
    /// to interleave them.
    #[test]
    fn gc_sweep_vs_claim_never_drops_live_owner() {
        let (pid, start, exe) = self_identity();
        for i in 0..50 {
            let key = format!(
                "gcrace-{}-{}-{}",
                std::process::id(),
                i,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let _ = release(&key);
            // Plant a dead lock directly (simulated crash: pid/start/exe never match).
            let dead = Lock {
                pid: 999_999,
                process_start: 1,
                exe: "/nope".into(),
                focus_port: 1,
                token: "d".into(),
                root: key.clone(),
                real_root: key.clone(),
            };
            std::fs::write(&lock_path(&key), serde_json::to_string(&dead).unwrap()).unwrap();

            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

            let claim_handle = {
                let key = key.clone();
                let exe = exe.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait(); // release together into the same instant
                    try_claim(&key, || Lock {
                        pid,
                        process_start: start,
                        exe: exe.clone(),
                        focus_port: 4000,
                        token: "live".into(),
                        root: key.clone(),
                        real_root: key.clone(),
                    })
                })
            };
            let sweep_handle = {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    gc_sweep()
                })
            };

            let claim_result = claim_handle.join().unwrap().unwrap();
            let _ = sweep_handle.join().unwrap();

            if matches!(claim_result, ClaimResult::Won) {
                let owner = live_owner(&key);
                assert!(
                    owner.is_some(),
                    "gc_sweep must not drop the freshly-claimed live owner (iter {i})"
                );
                assert_eq!(
                    owner.unwrap().pid,
                    pid,
                    "live owner pid must be the claimer's live pid (iter {i})"
                );
            }
            release(&key);
        }
    }
}
