# Changelog

## 1.0.0 — 2026-09-21

First release of the monorepo. Seven adapters, one core.

**Core (`core/cc-usage.mjs`)**

- Reads Command Code plan usage: rolling 5-hour and weekly windows, monthly credits,
  reset times. Caps come from the API; a local plan table is only a fallback.
- Credential discovery in five steps, from explicit env vars through the provider routes
  the user already configured in any of the supported agents.
- Disk snapshot with background refresh: first call is a live read, later calls answer in
  ~90 ms from the snapshot and refresh behind it.
- Decides **per turn** whether the session is actually routed to Command Code — from the
  local router's own env mapping, or the model the transcript records. Not in Command
  Code's public model catalog → the status line hides itself.
- Fails quietly: no credential, no API access, offline, or a rejected key all render
  nothing rather than an error. A failed fetch backs off for five minutes.
- Runs as a CLI or imports as a library (`fetchView()`, `resolveCredentials()`, `normalize()`).

**Adapters**

| Agent | Surface | Notes |
|---|---|---|
| Claude Code | status line (multi-line, ANSI) | `setup.mjs` merges with an existing status line and restores it on `--remove` |
| opencode | TUI sidebar section | plain JS, no build step |
| Grok Build | `[ui.status_line]` command row | `setup.mjs` edits `config.toml` |
| pi | widget above the editor | `/ccq-bar on\|off\|toggle\|refresh\|status` |
| Codex CLI | `UserPromptSubmit` hook | one line per turn, `systemMessage` so it stays out of the model's context |
| DeepSeek Harness | sidebar card | keeps its own data layer — see the note below |
| ZCode | `/quota` command | conversation-only; ZCode has no persistent UI slot |

**Deliberate omissions**

- **No pacing warning.** The projection is in `--json` but never shown: extrapolating from
  a short sample reports "you will run out" almost every time, and a warning that is
  always on is not a warning.
- **No web panel.** Removed; checking a browser tab is no better than the vendor's own
  dashboard, and it was the heaviest part of the script.

**Known exception**

`plugins/dsh` keeps its own `quota.mjs` rather than importing the shared core — its host
and client halves plus 141 offline checks are built against that contract. Everything else
in the monorepo shares `core/cc-usage.mjs`.
