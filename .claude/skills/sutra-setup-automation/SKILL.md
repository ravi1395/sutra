---
name: sutra-setup-automation
description: >
  Set up a run or debug automation for the open Sutra workspace when the user knows what they
  want to do ("run this app", "launch it in debug mode", "add a test command") but not the exact
  command or config. Use whenever the user asks Sutra to build/run/debug a project it hasn't been
  told how to run, or asks to "add an automation", "set up run/debug", or "figure out how to
  start this". The skill inspects the project — any language, any stack — infers the correct
  command (favouring a debug-mode launch), and saves it as a Sutra automation via the Sutra MCP
  tools so it becomes a one-click button in the automation bar. Requires the `sutra` MCP server.
---

# Set up a Sutra automation

Goal: turn "I don't know how to run/debug this" into a saved, runnable Sutra automation — without
asking the user for commands they don't have. You identify the project, infer the command, and
persist it through the Sutra MCP tools.

This skill is **language-agnostic**. The marker files below are hints to speed up recognition, not
a closed list. If a project uses a stack not listed, reason about it the same way: find how it is
built and started, then express that as a shell command.

## Tools you will use (Sutra MCP server)

- `list_automations` — see what's already saved (avoid duplicate names).
- `create_automation({ name, command, kind? })` — persist an automation. `kind` defaults to
  `"shell"`; use `"test"` for a test command, `"diagnostics"` only with a parser. Returns the new
  id or a validation error (empty/over-long/duplicate name, empty command).
- `run_automation({ name })` — launch it in a Sutra terminal (only if the user wants it run now).

You also have normal file access (Read/Grep/Glob) on the open workspace — use it to read configs
directly.

## Procedure

1. **Locate the project root and identify the stack.** Glob the workspace for build/run markers.
   Common ones (not exhaustive):

   | Marker(s) | Likely stack |
   |---|---|
   | `pom.xml` | Java / Maven |
   | `build.gradle`, `build.gradle.kts`, `gradlew` | Java/Kotlin / Gradle |
   | `package.json` | Node / JS / TS (read `scripts`) |
   | `Cargo.toml` | Rust |
   | `go.mod` | Go |
   | `pyproject.toml`, `setup.py`, `requirements.txt`, `manage.py` | Python (incl. Django) |
   | `*.csproj`, `*.sln` | .NET |
   | `Gemfile`, `config.ru` | Ruby / Rails |
   | `composer.json` | PHP |
   | `mix.exs` | Elixir |
   | `Makefile`, `Justfile`, `Taskfile.yml` | task-runner — read the targets |
   | `docker-compose.yml`, `Dockerfile` | containerised — consider a compose/run command |

   If several are present (e.g. a monorepo), pick the one matching what the user pointed at, or ask
   which subproject if it is genuinely ambiguous.

2. **Read the config to extract the real command.** Don't guess a script name — open the file and
   confirm it. E.g. read `package.json` `scripts` for the actual `dev`/`start` name; read `pom.xml`
   for the Spring Boot plugin or main class; read `Cargo.toml` for the binary target; read the
   `Makefile` targets. Respect any project-specific wrapper (`./gradlew`, `./mvnw`, `poetry run`,
   `npm`/`pnpm`/`yarn`/`bun` per the lockfile present).

3. **Prefer a debug-mode launch** when the user asked to debug (or by default for a "debug"
   automation). Typical debug forms — adapt to what the config actually supports:

   | Stack | Run | Debug (JVM/adapters listen for a debugger) |
   |---|---|---|
   | Maven (Spring Boot) | `./mvnw spring-boot:run` | `./mvnw spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005"` |
   | Maven (generic) | `./mvnw exec:java` | `mvnDebug exec:java` |
   | Gradle | `./gradlew run` | `./gradlew run --debug-jvm` |
   | Node | `npm run dev` | `node --inspect-brk <entry>` (or the script + `--inspect`) |
   | Python | `python main.py` | `python -m debugpy --listen 5678 --wait-for-client main.py` |
   | Django | `python manage.py runserver` | `python -m debugpy --listen 5678 manage.py runserver --noreload` |
   | Go | `go run .` | `dlv debug` |
   | Rust | `cargo run` | `rust-lldb target/debug/<bin>` (build first with `cargo build`) |
   | .NET | `dotnet run` | `dotnet run` with `VSTEST_HOST_DEBUG=1`, or `dotnet <dll>` under a debugger |

   Pick the port/entry from the project where possible; state the debug port you chose in your
   summary so the user can attach.

4. **Persist it.** Call `create_automation` with a short, clear name (e.g. `"Run"`, `"Debug"`,
   `"Debug (Spring Boot)"`) and the command. If the tool returns a duplicate-name error, either
   pick a distinct name or, if the user wants to replace, tell them and choose a new name — the
   tool does not overwrite by name. Confirm the returned id.

5. **Offer to run it.** Only call `run_automation` if the user asked to start it now; otherwise
   tell them the automation is saved and appears in Sutra's automation bar (the bolt button).

## Report back

State exactly what you detected and saved:

- Stack detected and the config file(s) you read.
- The command saved, and why (esp. the debug flags / port).
- The automation name + whether you ran it.

If the project could not be identified confidently, say what you found and ask one focused
question rather than saving a guessed command.
```
