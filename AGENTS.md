# Agent Guide

Be concise. Prefer small, direct edits. No broad refactors unless required.

## First Read

- Read `CODEMAP.md` before non-trivial code changes.
- Use it to find the owning module, main call path, nearest verification, and likely risk.
- Update `CODEMAP.md` in the same change when component responsibility, public behavior, commands, or test strategy changes.

## Change Discipline

- Keep diffs proportional to the request.
- Edit existing modules before adding new layers.
- Do not rewrite unrelated code.
- For broad changes, explain why and wait for confirmation.

## Verification

- Run the smallest relevant check after changes.
- Frontend/type check: `npm exec tsc -- --noEmit`
- Tauri/Rust check: `cargo check --manifest-path src-tauri/Cargo.toml`
- App smoke run: `npm run tauri dev`

## Docs

- Public feature changes require README updates in the same change.
- Keep implemented and planned behavior separate.
