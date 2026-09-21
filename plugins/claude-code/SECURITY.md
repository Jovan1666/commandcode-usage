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

The full policy — credential handling, and what is in and out of scope — is the
repository's [SECURITY.md](https://github.com/Jovan1666/commandcode-usage/blob/main/SECURITY.md).

## What this adapter touches

- Runs as the `statusLine` command, so it executes once per assistant message.
- Reads `~/.claude/settings.json` (the `env` block, to learn which local
  `ANTHROPIC_DEFAULT_*_MODEL` alias maps to which upstream model) and the session
  transcript the status line names on stdin — the transcript is opened only to read
  model names, and nothing from it is sent anywhere.
- Writes `~/.commandcode-usage/models.json`, the 24 h cache of the public model
  catalog, and nothing else.
- `scripts/setup.mjs` is the one thing that changes your machine outside that
  cache: it sets `statusLine` in `~/.claude/settings.json` and keeps a timestamped
  `.bak-*` copy. Read the diff it prints before you accept it.

A command that runs on every message is a command whose startup cost is a feature;
it is also a command whose file access should be this boring. Keep it that way.
