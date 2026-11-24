# Changelog

All notable changes to `@wdlpiaoyi/dsh-matriline`. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
semantic versioning.

## 0.12.0 — first public release

### Added

- Kind-based capability tiers (`read` / `write` / `verify`). Permissions are
  monotonic: a child cannot escalate by delegating again.
- Tool-surface and system-prompt trimming for delegated children, so the first
  request of a subagent no longer inherits the parent's full tool set.
- Write-scope leases with a tool-level guard and optional git-worktree isolation,
  plus a per-delegate and whole-batch admission check.
- Structured results judged from the child's own session log, batch fan-out with
  automatic reconciliation, and explicit child cancellation.
- A right-sidebar parent/child topology tab, and a per-session trim switch in the
  model menu (backed by this bundle's own state row, one card on the plugin page).
- Child model selection that follows the official `subagentModelSelection` switch.
- Documentation: README (Chinese and English), SECURITY.md, CONTRIBUTING.md.

### Hardened

- A leased writer cannot write the plugin's own data directory or package
  directory: it could otherwise flip `matriline.paused` (silently disabling
  trimming for the whole product), rewrite another session's switch, or patch the
  plugin module. Root and read-only callers are unaffected.
- `state.json` and `config.json` are written through a temp file and an atomic
  rename, so a crash mid-write cannot truncate them.
- The plugin data directory is created `0700` and its files `0600` on POSIX.
- `matriline.log` rotates at 5 MB, sharing the rotation shape of the run ledger.
- Public comments no longer cite non-public host documentation sections or quote
  host source lines; the behaviour they explained is unchanged.

### Notes

- No runtime dependencies, no build step, no lifecycle scripts. Install from npm
  (`@wdlpiaoyi/dsh-matriline`), git, or a local directory.
- DSH compatibility window is declared by `engines.dsh`; see the README.
