# Release auto-update — design + setup

**Date:** 2026-06-19
**Status:** implemented (frontend + backend + CI wiring); requires one-time repo-secret setup to go live.

## Decision

- **Mechanism:** full in-app updater via `tauri-plugin-updater` (auto-download + install + relaunch). Not a notifier.
- **Cadence:** poll the release endpoint every **6 hours**, plus one check ~8s after boot.
- **UI:** an "Update" pill rendered **beside the centered command-palette button** (`#btn-palette`). Hidden until a newer signed release is found. Clicking downloads, installs, and relaunches with live progress.

## How it works

1. `src/updater.ts` (`mountUpdater`) runs `checkForUpdate()` on the cadence above.
2. `tauri-plugin-updater` fetches `latest.json` from the endpoint, compares its `version` to the running app version, and verifies the bundle signature against the public key embedded in `tauri.conf.json`.
3. When an update exists, the pill appears. On click → `installUpdate()` streams `Started`/`Progress`/`Finished` events into the pill label → `relaunchApp()`.

## Wiring map

| Concern | Location |
|---|---|
| Crates | `src-tauri/Cargo.toml` — `tauri-plugin-process`, `tauri-plugin-updater` (desktop-only target) |
| Plugin registration | `src-tauri/src/lib.rs` — `process` in the builder chain; `updater` in `setup()` under `#[cfg(desktop)]` |
| Endpoint + public key | `src-tauri/tauri.conf.json` → `plugins.updater`; `bundle.createUpdaterArtifacts: true` |
| Permissions | `src-tauri/capabilities/default.json` — `updater:default`, `process:allow-restart` |
| JS plugins | `package.json` — `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process` |
| IPC wrappers | `src/ipc.ts` — `checkForUpdate`, `installUpdate`, `relaunchApp` |
| Controller | `src/updater.ts` — `mountUpdater`, `progressPercent` (tested) |
| Button markup/styles | `index.html` (`#center-cluster`, `#btn-update`), `src/styles.css` |
| Release pipeline | `.github/workflows/release.yml` — signs artifacts + emits `latest.json` |

## Endpoint

```
https://github.com/ravi1395/sutra/releases/latest/download/latest.json
```

`releases/latest` resolves to the most recent **published** (non-draft) release. The CI creates the release as a **draft**, so a build only goes live to users once that release is published.

## One-time setup (required before updates ship)

A signing keypair was generated for this feature. The **public** half is committed in
`tauri.conf.json`. The **private** half must be stored as repo secrets so CI can sign:

1. `Settings → Secrets and variables → Actions → New repository secret`
2. Add `TAURI_SIGNING_PRIVATE_KEY` = the base64 private key (kept out of git).
3. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = empty (the key was generated with no password).

> The private key is **not** in the repo. If it is lost, regenerate with
> `npx tauri signer generate -w sutra.key`, replace `plugins.updater.pubkey`
> in `tauri.conf.json`, and update the secret. Any release signed with the old
> key will then fail verification.

## Release procedure

1. Bump `version` in both `package.json` and `src-tauri/tauri.conf.json`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI builds, signs, and attaches bundles + `latest.json` to a **draft** release.
4. Publish the draft release → installed clients pick it up within 6h (or on next launch).

## Notes / follow-ups

- Check failures (offline, rate-limit) are swallowed; the next cycle retries. Install failures surface a native alert and leave the pill clickable for retry.
- macOS: until Apple notarization secrets are wired in the workflow, bundles are ad-hoc signed — updater signature verification is independent of Apple notarization and still works.
- Possible later polish: a "restart now / later" choice after download instead of immediate relaunch.
