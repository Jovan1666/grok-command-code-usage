# Changelog

## 1.0.1 — 2026-09-24

- **The monthly amount on the status line is labelled.** `月 ██▏ 18% 剩$57.60` — the bar is what
  has been used and the figure is what is left, so the figure needed a word in front of it.
  Same in the three-row layout.
- **Quota snapshots refresh every three minutes instead of every minute** (`cacheTtl` 60s → 180s).
  The old default was short enough that a repaint could start a background process and make four
  API calls — for a number that cannot visibly move in three minutes. Pass `--cache-ttl 60` to
  restore the old cadence.

## 1.0.0 — 2026-09-21

First release.

**The script (`scripts/cc-usage.mjs`)**

- Reads Command Code plan usage: rolling 5-hour and weekly windows, monthly credits,
  reset times. Caps come from the API; a local plan table is only a fallback.
- Credential discovery in four steps, from explicit env vars through the Command Code provider
  route already configured in Grok's own `config.toml`.
- Disk snapshot with background refresh: first call is a live read, later calls answer in
  ~90 ms from the snapshot and refresh behind it.
- Decides **per turn** whether the session is actually routed to Command Code — from the
  local router's own env mapping, or the model Grok's session log records. Not in Command
  Code's public model catalog → the status line hides itself.
- Fails quietly: no credential, no API access, offline, or a rejected key all render
  nothing rather than an error. A failed fetch backs off for five minutes.
- Runs as a CLI or imports as a library (`fetchView()`, `resolveCredentials()`, `normalize()`).

**Grok Build integration**

- `[ui.status_line]` command row. Grok has no status-line slot in its plugin format, so
  `scripts/setup.mjs` writes the section into `~/.grok/config.toml`: it backs the file up
  first, refuses to touch an existing status line it did not write unless `--force`, and
  `--remove` restores what was there. Reinstalls cleanly after `--remove`.
- On Windows it also writes a `cc-usage.cmd` launcher beside `cc-usage.mjs`, because Grok
  cannot start a command that carries an absolute-path argument (`os error 123`).
- `/quota` prints the compact panel in the conversation. It goes through the model (it is a
  prompt, so it costs a turn); the status line is the free path.

**Deliberate omissions**

- **No pacing warning in the status line.** The projection is in `--json`, and the panels you
  ask for (`--compact`, `--md`, `--html`, the terminal view) still print it — it is only kept
  out of the always-on surface. Extrapolating from a short sample reports "you will run out"
  almost every time, and a warning that is always on is not a warning.
- **No web panel as the default surface.** The status line is the primary path; `--html`
  still exists for the occasional big-picture look, but nothing points you at a browser tab —
  checking one is no better than the vendor's own dashboard.
