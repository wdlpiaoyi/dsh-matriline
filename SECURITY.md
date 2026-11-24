# Security policy

## Supported versions

Only the latest published version of `@wdlpiaoyi/dsh-matriline` is supported. Older versions receive no security fixes; upgrade before reporting.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** form on this repository (Security tab). Do not open a public issue, and do not post exploit details publicly. Please allow time for a fix before public disclosure.

## In scope

- Bypassing the write-scope lease or the tool-level write guard.
- A `read` / `verify` child acquiring write capability, including through re-delegation or resume.
- Bypassing tool or prompt trimming through delegation arguments.
- A leased writer being able to modify the plugin's own data directory or package files.

## Out of scope by design

- Shell writes via `bash` / `pwsh`: the tool-level guard cannot parse shell commands (use `isolate: true`).
- `scope` as a self-boundary: it is mutual exclusion among writers only, not a limit on the writer itself.
