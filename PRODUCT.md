# Product

## Register

product

## Platform

web

## Users

Primary: a developer using Sutra as a daily-driver code editor, often running AI coding agents (Claude, Codex) in its integrated terminals alongside their own editing. Secondary: the same developer in a review context — reading the git diff gutter, agent turn tracking, and rollback tools to decide whether to trust and keep AI-made changes.

## Product Purpose

A minimal native code editor (Rust + Tauri) pairing a CodeMirror 6 multi-tab editor with real PTY terminals and a git-aware diff gutter — no language server sprawl, no extension marketplace, no Electron overhead. Success is a fast, low-chrome loop: open a folder, write code, run a shell, review what changed, trust or roll back what an agent touched.

## Positioning

The fast, low-chrome editor — speed and simplicity over IDE feature-bloat.

## Brand Personality

Sharp, minimal, fast. Terse and unshowy; the UI should read as an efficient instrument, not a platform. Copy and chrome stay out of the way of the terminal and the diff.

## Anti-references

Not an Electron/VS Code clone — no generic IDE chrome, no heavy multi-panel sprawl, no extension-marketplace visual language, no command-bloat menus.

## Design Principles

- Speed and low chrome over feature surface area — every added panel or control has to earn its screen space.
- The terminal and the diff are the product; UI decoration must never compete with them for attention.
- Trust is earned through visibility, not reassurance copy — show the agent's actual changes (diff gutter, turns, rollback), don't narrate them.
- One token system, no legacy aliases — ink (dark) and washi (light) themes stay in lockstep; new UI consumes existing semantic tokens before inventing new ones.

## Accessibility & Inclusion

Standard WCAG AA — contrast and keyboard navigation across both ink and washi themes; no additional stated requirements.
