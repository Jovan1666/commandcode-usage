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

- A sidebar card **and one settings section**. The host half registers exactly one
  route, `cc-quota/report`, on the shared `/api` transport the host already runs;
  the browser half is a hand-authored bundle that renders that route's answer, both
  as the sidebar card and as a section in the host's own settings dialog.
- Reads the provider route from `settings.yaml` or a patch layer
  (`cordis.patch.yml` at the DSH home or under `profiles/<name>/`, which is where
  the desktop app keeps settings), and the official CLI credential at
  `~/.commandcode/auth.json`.
- Reads the public plan pages under `https://commandcode.ai/docs/plans/…` and
  `/docs/resources/pricing-limits` to know what each model in the plan can call.
  These requests carry **no credential at all** — they are the same pages a browser
  would open. A check sends a `HEAD` first and only downloads a page when the
  vendor's ETag says it changed (about 200 KB, at most one check a day by default;
  `COMMANDCODE_CATALOG_TTL_MS` moves that). Only the parsed numbers are kept.
- The client touches the DOM for exactly two things: injecting one stylesheet keyed
  `.ccq-`, and rendering. No `localStorage`, no cookies, no direct network calls —
  both surfaces ask the host for data and the host makes the request.
- Writes exactly two files, both under `$DSH_HOME/dsh-commandcode-quota/`:
  `last-report.json` (the quota snapshot, carrying a short digest of the key so it
  cannot be shown to a different account) and `catalog.json` (the parsed model
  allowances, holding no credential material at all). Nothing else on your machine
  is written by this plugin.
- Requires `dsh >= 0.1.5-rc.1`. On an older host the plugin does not load, which is
  the intended failure — better a plugin that refuses than a card that renders
  nothing.

The card runs inside the host's renderer, so a bug here is a bug in a trusted
context. Report anything that lets a server response reach the DOM as markup rather
than as text.
