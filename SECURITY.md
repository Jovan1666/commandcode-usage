# Security Policy

## Supported versions

The latest commit on `main` is supported. Fixes land there; there are no backport
branches and no maintained older releases.

## Reporting a vulnerability

Report privately through GitHub: open the **Security** tab of
<https://github.com/Jovan1666/commandcode-usage> and choose **Report a
vulnerability**. If that channel is not available to you, open a normal issue that
says only that you have a security report and how to reach you — put no details in
the issue itself.

Say what you ran, what happened, and what you expected; a minimal reproduction is
worth more than a long description. This is a personal project maintained in spare
time, so expect an acknowledgement within a few days, and please hold public
disclosure until a fix is out.

## What this repository does with your machine

Every plugin here has the same shape, and that shape *is* the security model:

| | |
|---|---|
| **Reads** | The host's own config and session data — the files the host already writes, and nothing else. |
| **Writes** | One cache directory, `~/.commandcode-usage/` (the public model catalog, 24 h TTL). |
| **Sends** | HTTPS to `https://api.commandcode.ai` with **your own** key. No other host appears in the code. |
| **Collects** | Nothing. No telemetry, no analytics, no error reporting, no identifiers. |
| **Install** | Runs nothing. No `postinstall` script, no downloaded code, no remote configuration. |

The API calls are `GET /alpha/whoami`, `/alpha/billing/credits`,
`/alpha/billing/subscriptions`, `/alpha/usage/summary` — all with your key — and
`/provider/v1/models`, which is public and needs no key at all.

### The only host config any plugin writes

Two hosts have no plugin mechanism that can declare a status line, so those two
adapters edit the host's config directly, and neither does it silently:

- `plugins/claude-code` — `scripts/setup.mjs` sets the `statusLine` key in
  `~/.claude/settings.json`, after writing a timestamped `.bak-*` copy of the file.
  `--remove` takes it back out.
- `plugins/grok` — `scripts/setup.mjs` sets `[ui.status_line]` in
  `~/.grok/config.toml`, after a backup, and refuses to touch an existing entry
  unless `--force` is passed. `--remove` restores what was there.

The other five (`codex`, `zcode`, `dsh`, `opencode`, `pi`) install through their
host's own plugin mechanism and write no host config at all. Every adapter whose
installer edits a file prints the exact path before it does, and accepts `--help`
without touching anything.

## Credentials

Your Command Code key is discovered in this order, and used for nothing except the
`Authorization` header of the requests listed above:

1. `COMMAND_CODE_API_KEY`, `COMMANDCODE_API_KEY`, or `CMD_API_KEY`
2. `~/.commandcode/auth.json` (written by the Command Code CLI login)
3. `~/.zcode/v2/provider_config.json` (the provider route you configured in ZCode)
4. A host config file — `apiKey = "..."`, or `apiKeyEnv = "NAME"` to name an
   environment variable instead of inlining the value

A key is never written to a log, to the cache, or into anything the plugin
renders. Prefer the environment variable over a literal in a config file that
might get committed. If you believe a key of yours is exposed, revoke it in your
Command Code account first — that is the only step that actually helps.

## Scope

In scope: anything in this repository that leaks a credential, sends data anywhere
other than the API base above, writes outside the paths listed here, or turns an
untrusted input (a session file, a transcript, a config value) into code execution.

Out of scope: the Command Code API itself; the hosts (Claude Code, Codex, ZCode,
Grok Build, opencode, pi, DeepSeek Harness) and their plugin mechanisms; and
anything that requires an attacker who already holds your key or your shell.
