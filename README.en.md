# Matriline

> A pod of delegated subagents: trimmed, tiered, and leased.
>
> 中文名：宗正寺鲸。

[中文](README.md) · English

An unofficial community plugin for the DeepSeek Harness (DSH): it trims the tool surface and system prompt a delegated subagent receives, enforces capability tiers and write-scope leases, judges a child's status from its own session log, and renders the parent/child topology in the right sidebar.

> This is an unofficial community plugin: not affiliated with, endorsed by, or supported by DeepSeek.

> The plugin's runtime UI is currently Chinese-only. This README keeps each Chinese label and gives an English gloss in parentheses on first use.

## Core capabilities

1. **Tool and prompt trimming**: trims the subagent tool set and system prompt per task, reducing first-request tokens.
2. **Capability tiers**: provides three capability sets: read-only, write, and verify. Permissions are monotonic; a subagent cannot escalate by delegating again.
3. **Write-scope protection**: reduces concurrent write conflicts through write-scope leases, a tool guard, and optional git worktree isolation.
4. **Structured results**: determines execution status from the child session log, not from the subagent's own account.
5. **Runtime visualization**: the right sidebar's 「子代理拓扑」 (subagent topology) shows parent-child relations, messages, tokens, and context usage.

## Environment requirements

- Node.js `>=22.15`: matches the Node runtime bundled with DSH; the plugin uses only the Node standard library and has no runtime dependencies.
- DSH `>=0.2.0-rc.1 <0.3.0`: same as `engines.dsh` in `package.json`; tested on `0.2.2-rc.5`. See [Compatibility](#compatibility) for the compatibility promise.
- Optional: the worktrees bundle in the host orchestration, for the physical isolation of `isolate: true`.

> DSH rejects incompatible versions according to `engines.dsh`. Before upgrading to DSH 0.3.x, you must first publish a plugin version that widens the compatibility window.

## Installation

Install through `plugin_manager` → `install_bundle`. The package has no runtime dependencies and no build step: the sources listed in `files` run as-is, so no `npm install` is needed after cloning or extracting.

### Install from a local directory

Suited to development and offline environments. Windows:

```text
action: install_bundle
target: C:\path\to\dsh-matriline
```

macOS / Linux:

```text
action: install_bundle
target: /path/to/dsh-matriline
```

The install directory must contain:

- `package.json`
- `index.js`
- `client.js`
- `cordis.patch.yml`
- `state/` (the module behind the `matriline-state` row, installed with the package as its `./state` subpath)

### Install from Git

The repository is public; cloning needs no credentials:

```text
action: install_bundle
target: git+https://github.com/wdlpiaoyi/dsh-matriline.git
```

For the items to recheck after repository changes, see the [release checklist in CONTRIBUTING.md](CONTRIBUTING.md#release-checklist).

### Install from npm (available once published)

```text
action: install_bundle
target: @wdlpiaoyi/dsh-matriline@0.12.0
```

The package is not on npm yet; this works once it is published under the `@wdlpiaoyi` scope. Until then, use the local-directory or Git install above.

### Configure the per-session switch

The model-menu switch depends on one profile state row:

- Entry id: `matriline-state`
- Module: `@wdlpiaoyi/dsh-matriline/state` (this package's `./state` subpath, no longer a separate package)
- Config: `config.sessions`
- Storage: volatile
- The main plugin reads the config through an in-process state store

The row is inserted by **this package's own bundle patch** (the root `cordis.patch.yml`), together with `matriline`: both are rows of ONE bundle card, so there is nothing to insert by hand and no second package to install.

```yaml
- insert:
    - id: matriline
      name: '@wdlpiaoyi/dsh-matriline'
      config: {}
    - id: matriline-state
      name: '@wdlpiaoyi/dsh-matriline/state'
      config:
        sessions: {}
```

The profile's `cordis.patch.yml` keeps only the `config.sessions` override the Settings editor maintains — no `insert`, and no `name`: a `name` only *asserts* the module of an existing row, and a wrong value makes the whole patch row be skipped with a warning (so the switch silently stops applying).

```yaml
- id: matriline-state
  config:
    sessions: {}
```

The Settings editor writes that row on the first switch change; `sessions` may be empty.

### Restart and uninstall

- Deployments that support HMR or host-module hot loading usually need no restart, and the client module also hot-updates.
- Without hot loading, restart the host according to the `restart-required` and `nextStep` returned by `install_bundle`.
- Uninstall: `plugin_manager` → `remove_bundle`, with target `@wdlpiaoyi/dsh-matriline`.

## Switch and commands

| Control | Behavior |
|---|---|
| Default state | On; takes effect automatically for new sessions |
| Model menu 「启用子代理工具裁剪」 (Enable subagent tool trimming) | Controls default trimming for the current session; independent of the official 「启用智能体团队协作」 (Enable agent teamwork) |
| `matriline.paused` present in the data directory | Globally pauses default trimming |
| `matriline.noprompt` present in the data directory | Turns off the compact prompt; deleting the file restores it |

Toggling the model-menu switch refreshes the tool table and invalidates that session's prompt cache once for the next request. Do not toggle it frequently.

`matriline.paused` only affects subagents that do not explicitly specify `kind`, including the official `subagent`, `subagent_fork`, or subagents dispatched by other creators. It does not affect:

- a `kind` explicitly specified in `delegate`, `delegate_many`, or `deliberate`;
- Tier 1 write-scope leases;
- the Tier 2 `tools` guard;
- Tier 3 `isolate` worktrees.

This plugin registers no slash commands. A switch writes `config.sessions = { <sessionId>: boolean }`, then updates the tool surface and appends a `plugin:matriline/gate` projection record, producing no chat message.

## Delegation API

### Single-task delegation

```text
delegate(task, kind, name?, wait?, budgetMs?, scope?, isolate?, skills?, tools?, timeoutAction?, maxRuntimeMs?, model?, provider?, reasoningEffort?)
```

#### Capability sets

| `kind` | Purpose | Default capabilities |
|---|---|---|
| `read` | Read-only task, the default | Read-only sandbox; `read`, `grep`, `glob`, `read_image`, `list_agents`, `send_message`, `delegate`, `cancel_subagent` |
| `verify` | Independent review | Same as `read` |
| `write` | File changes and command execution | Minimal tool set by default; the sandbox is `workspace-write` |

The `WRITE_MINIMAL_TOOLS` list for `write` contains 16 entries:

- Files: `read`, `write`, `edit`, `apply_patch`
- Search: `grep`, `glob`, `read_image`
- Shell: `pwsh`, `bash`
- Subagents: `delegate`, `cancel_subagent`, `send_message`
- Other: `todo_write`, `working_directory`, `web_fetch`, `web_search`

The actual tool set is the intersection of that list with the tools visible to the subagent. Tools the host has not registered are silently dropped.

When you need more tools, use:

```text
delegate(kind="write", tools="full")
```

Or specify them exactly:

```text
tools=["plugin_manager", "schedule_create"]
```

`write` removes the `skill` tool by default, and the `read` / `verify` tool sets never include it. `skills: true` keeps it in the tool table, and the skill catalog then arrives as an extra `user/message` in that session — which changes the request prefix and **breaks that session's prompt cache**. Decide `skills` at dispatch time and leave it unset by default.

#### Return structure

```jsonc
{
  "status": "ok|partial|denied|error|timeout|interrupted|depth-exhausted|running",
  "summary": "…",
  "child": "<child session id>",
  "denials": [{ "tool": "write", "code": "FS_SANDBOX_DENIED" }],
  "usage": { "totalTokens": 0 },
  "elapsedMs": 0
}
```

Status semantics:

- `ok`, `partial`, `denied`, `error`, `timeout`, `interrupted`, and `depth-exhausted` are the seven terminal states.
- `running` appears only in unawaited results with `wait: false`; it means the task has started and the result will arrive later by message.
- `denied` is used only for policy refusal before dispatch, such as a write-scope conflict, escalation, a whole-batch atomic rejection, or a child model refused by the official model-selection switch / allowlist.
- Sandbox or guard refusals after the subagent has started are recorded in `denials[]` and do not by themselves change the status to `denied`.
- The final status is decided by `stopReason` and `turn/end` in the child session log; recovered tool errors do not misclassify a successful completion as a failure.

#### Waiting and timeouts

- `wait` defaults to `true`, waiting for the subagent to finish; for long tasks, prefer `wait: false` to avoid blocking the main conversation.
- `budgetMs` is the wait cap for `wait: true`, not the task lifetime.
- After a wait timeout, it returns `status: "timeout"` and `child`; by default the subagent keeps running and keeps holding its write scope.
- After a timeout, do not re-dispatch the task with the same `scope`, or it may be rejected by the still-running write lease.
- You can continue it with `send_message`, or stop it with `cancel_subagent(childId)`.
- `timeoutAction: "interrupt"` means interrupt as soon as the wait times out.
- `maxRuntimeMs` is the task lifetime cap and also applies to `wait: false`; the default `0` means unlimited.

#### State recovery on resume

A subagent can be continued with `send_message` after it ends. Resume replays `agent/created` and restores the following state:

| State | Session log record | Impact when not restored |
|---|---|---|
| `kind` | `plugin:matriline/kind` | With the gate on, it is re-trimmed to the `read` minimum (write capability is stripped); with the gate off, it stays untrimmed, so a resumed child may still hold write capability |
| `tools` profile | `plugin:matriline/tools` | `tools: "full"` could shrink back to minimal |
| `skills` | `plugin:matriline/skills` | A lost `skills: true` record degrades to the `false` default, so the `skill` tool and the skill catalog are stripped |
| Write-scope lease | `plugin:matriline/lease` | The guard cannot recognize the write scope; writers without a record are rejected fail-closed |

The restore order is: in-memory Map → session log record → default value. A child session's `kind` falls back to `read` by default, and write scopes are handled fail-closed.

### Batch delegation

```text
delegate_many(tasks[], maxConcurrent?, wait?, budgetMs?, reconcile?, reconcileQuestion?)
```

- The “set kind → start” phase runs serially, because `pendingKind` is a single slot; the task-waiting phase runs in parallel.
- Queueing during the creation window may delay the start of later subagents; it does not mean the waiting phase is serialized.
- Write scopes undergo a whole-batch atomic pre-check; see [Write-scope mutex](#write-scope-mutex).

`reconcile: true` runs “synthesize → conflict detection → internal arbitration” and adds:

- `merged`: the merged conclusion.
- `findings[]`: `{ claim, evidence[] }`, at most 8 entries.
- `conflicts[].verdict`: records only genuinely contradictory conflicts; wording differences are not counted.

The prompt for `findings[].evidence` asks to fill in only `path:line` values that actually exist in the results, but the code does not verify the paths, so this is a soft constraint.

### Multi-party discussion

```text
deliberate(topic, participants=3, rounds=2, budgetMs=180000)
```

Process:

1. N read-only subagents each give an independent conclusion.
2. A summary of the other participants' positions is fed back to the same subagent for a second round of continuation.
3. The results are merged into `consensus` and `disagreements`.
4. At most two genuinely contradictory disagreements trigger internal arbitration; each arbiter is a new subagent.

Constraints and return:

- `participants` ranges over `2..5` and `rounds` over `1..2`; out-of-range values are rejected outright.
- Only `kind="read"` is supported.
- The request cost is about `N × (rounds + 1)`; do not use it in place of ordinary batch reads.
- Suited to option choices that are contested and need review from multiple viewpoints.
- `rounds` is the number of request rounds; `roundsSkipped` is the number of rounds skipped because the budget was exhausted or no participants were available.
- When the second round is cut short by `denied` or `error`, it returns `partial` and does not masquerade as `ok`.
- When the end of a continuation cannot be reliably awaited, it degrades to “re-dispatch participants and write in others' positions”, returning `resumeUnsupported: true`.

### Model selection

```text
delegate(task, kind, model?, provider?, reasoningEffort?)
```

- **Follows the official switch**: `delegate` and `delegate_many` accept an explicit `model`, `provider`, or `reasoningEffort` only while Settings → Subagent settings → “Allow the Agent to choose a model for a subagent” (`subagentModelSelection`) is readable and on. With that switch off the whole field group is refused and the child inherits this session's model — off means off, instead of the previous behaviour where turning it off removed the allowlist and let any route be chosen.
- The refusal happens before dispatch: `status: "denied"` with `MODEL_SELECTION_CLOSED` (switch off), `MODEL_NOT_ALLOWED` (not on the allowlist, or the allowlist is empty), or `MODEL_POLICY_UNUSABLE` (the policy recorded for this session names no usable route — it was written at session creation, so changing the setting cannot revive it) in `denials`.
- While the switch is on, the selectable routes are limited to the setting's allowlist; an empty allowlist allows nothing — an effort-only request is refused too.
- A session that already carries a recorded `subagent/model-selection-policy` follows that record: as with the official projection, turning the switch off later does not retroactively revoke an existing session, and a forked session inherits the policy recorded in its parent (the whole session log is scanned, not only the events after the fork).
- A session with no recorded policy follows the live switch, so turning the switch on later also applies to it.
- When the official settings row is not mounted, or its `enabled` flag is not a readable boolean, no allowlist decision is made — validation never makes `delegate` unusable.
- Omitting `model` inherits the current session's model.
- You can set only `reasoningEffort`; the model still inherits from the current session, and the official switch and allowlist govern that field too.
- For an invalid model name, it returns the model list actually available from that provider.
- No price or cost statistics are provided; the host exposes only a model's `id`, `name`, and `description`, with no reliable price metadata.

## Write safety and isolation

### Write-scope mutex

```text
delegate(kind="write", scope=["src/foo/**", "docs/b.md"])
```

Rules:

- A writer that declares no `scope` leases the whole workspace by default; the same parent session can have only one such writer at a time.
- When two leases overlap, dispatch returns `denied` and `WRITE_SCOPE_OVERLAP`.
- Before starting any subagent, `delegate_many` checks the pairwise intersections of leases within the batch and their intersections with existing leases; any conflict rejects the whole batch and returns `results: []`.
- Queued tasks and pending leases not yet promoted also take part in conflict detection.
- A resumed writer restores its lease from `plugin:matriline/lease`.
- At runtime, the global `tools.guard` intercepts `write`, `edit`, and `apply_patch` that fall into another lease.

Supported `scope` forms:

- a bare file or directory;
- `dir/**`;
- `dir/*`;
- `dir/`.

Other wildcard forms (for example a lone `**` or `*.ts`) return `WRITE_SCOPE_INVALID` and are not expanded.

> `scope` is a mutual-exclusion declaration among writers, not the writer's own write boundary. The guard rejects only paths that fall into someone else's lease; it does not reject a writer's operations beyond its own scope. To restrict the range of writable files, use `isolate: true`.

### Three-layer protection

| Layer | Intercepts `write` / `edit` / `apply_patch` | Intercepts shell writes |
|---|---|---|
| Tier 1: dispatch lease | Yes | No |
| Tier 2: tool guard | Yes | No |
| Tier 3: worktree | Yes | Yes, depends on filesystem isolation |

The tool guard decides lease ownership from the explicit file arguments of `write`, `edit`, and `apply_patch`. `pwsh` and `bash` provide only command text: targets may sit in redirections, inside scripts, in relative paths, or in build tools and cannot be reliably enumerated, so the tool layer does not parse shell commands and allows them by default.

To cover shell writes, you must use an independent git worktree with `isolate: true`.

### worktree isolation and write gating

A writer with `isolate: true` runs in a private worktree:

- `write`, `edit`, and `apply_patch` outside the worktree are always rejected.
- Isolation of the shell depends on the independent checkout, not on command parsing.
- When the worktrees bundle is not installed, the subagent still runs but is not isolated; the result includes `worktreeError: "worktree service unavailable"`.

A worktree can be created only at the subagent's first `turn/start`. At the `agent/created` stage the context is not yet active, and creating it directly throws `cannot create effect on inactive context`. The window before creation is handled by two mechanisms:

1. **Hard gating**: the global `tools/pre-execute` hook suspends `write`, `edit`, `apply_patch`, `pwsh`, and `bash` until the worktree is ready, waiting at most 10 seconds each time. On timeout, failure, or interruption it lets the call through and logs it; the gating entry is removed only after the worktree is ready, and later writes still perform a bounded wait.
2. **Soft hint**: before the task, the subagent is told to confirm that the current directory contains `.agents/worktrees/` before writing files; if not, wait 2 seconds and check again.

## Observability

### Subagent topology

The right sidebar's 「子代理拓扑」 (subagent topology) shows the parent-child topology, message traffic, tokens, and context usage.

Auto-hiding is display filtering only and does not delete data. A node is auto-hidden when all of the following hold:

1. **In a terminal state**: one of the seven standard terminal states; the client also treats `failed` and `idle` as terminal. `running` and `waiting` are never hidden.
2. **Ended more than 2 hours ago**: prefer `endedAt`, falling back to `updatedAt` when it is missing.
3. **Not among the 8 most recently finished nodes**: ordered by `endedAt` descending, the first 8 are always visible.

Other rules:

- The root node is never hidden.
- 「显示已隐藏（N）」 (Show hidden (N)) expands auto-hidden nodes.
- Expanded auto-hidden nodes use about 0.45 opacity and a dashed border.

### Context warning

When a subagent ends, the ratio is computed from the context usage of the last request:

```text
(inputTokens + cacheReadTokens) / contextWindow
```

where `contextWindow` comes from that model's declaration in the `request/context` event.

- Above the threshold, the result includes `contextWarning`, and the rendered row ends with a marker such as `⚠ ctx 82%`.
- No warning is emitted when the subagent sent no request or `contextWindow` cannot be obtained.
- The default threshold is `0.8`, and the valid range is `(0, 1]`.

Edit `config.json` in the plugin data directory:

```json
{ "contextWarnRatio": 0.8 }
```

If the config is missing, corrupt, or holds an invalid value, it falls back to `0.8` without an error.

## Runtime files

Default data directory:

- Windows: `%USERPROFILE%\.dsh\matriline`
- macOS / Linux: `~/.dsh/matriline`
- With `DSH_HOME` set: `$DSH_HOME/matriline`
- With `MATRILINE_HOME` set: fully overrides the directories above; both the main plugin and the `./state` module resolve this same variable and share the directory

| Purpose | Path or file |
|---|---|
| Log | `matriline.log`; rotated to `matriline.log.<timestamp>` above 5 MB |
| Per-session switch state | `state.json` (migration-time legacy mirror) |
| Config such as the warning threshold | `config.json` |
| Global pause marker | `matriline.paused` |
| Compact-prompt off marker | `matriline.noprompt` |
| Run records | `runs.jsonl`; rotated to `runs.<timestamp>.jsonl` above 5 MB |

`apply: loaded (data dir: ...)` in the startup log records the actual data directory. Deleting `matriline.paused` restores default trimming.

`state.json` is a migration-time legacy mirror, not the authoritative switch store. To restore a session's default behavior, toggle the model-menu switch once, or remove that session's entry from the state row's `config.sessions` in the profile; deleting `state.json` does not revoke the real switch state (the old value may be rewritten).

### Session log records

The following ignorable plugin records are written to the session log rather than the plugin data directory:

- Child sessions: `plugin:matriline/kind`, `plugin:matriline/tools`, `plugin:matriline/skills`, and the write-scope lease record.

These records do not enter the model context; they are used only for state recovery on resume and should not be deleted by hand.

## Host dependencies and degradation

| Dependency | Behavior when missing |
|---|---|
| `sidebarRightTabs` | The client retries for about 10 seconds and then gives up registering 「子代理拓扑」; delegation, logging, and the switch are unaffected |
| `sidebarRight.openTab()` / `openResource()` and the `subagentchat` sidebar page | Affects 「打开会话」 (Open session): it prefers opening in a new right-sidebar tab, and falls back to the main pane with a hint when unsupported |
| `@deepseek-ai/dsh-client-ui-primitives` | The client falls back to built-in controls (`Switch` / `Modal` / `Button`); behavior is unchanged, and the look may differ from the official controls |
| `appendPluginRecord` of the host session module | The `plugin:matriline/*` records cannot be written to the session log, so resume state (kind / tools / skills / lease) and the gate record do not survive; in-memory state and the defaults still apply, and the switch itself is unaffected because it goes through the state entry |
| worktrees bundle | `isolate: true` does not isolate; the subagent keeps running and returns `worktreeError` |
| HMR / host-module hot loading | A restart is required after installation, following the host prompt |

`appendPluginRecord` is an optional capability of the host session API: the plugin makes a best-effort attempt to resolve the host's session module from the installed layout. When it is unavailable, the degradation in the table above applies; delegation, logging, and the switch are unaffected.

## Known limitations

1. No token price or cost statistics are provided.
2. When synthesis or arbitration fails, the affected fields degrade to `null` or `[]` and do not fail the whole batch.
3. A status has only the seven terminal states plus `running`; there is no finer classification of failure reasons.
4. `bash` and `pwsh` can bypass the tool-layer write-scope guard; use `isolate: true` when hard isolation is required.
5. `scope` provides only mutual exclusion among writers; it does not restrict the writer's own write boundary.
6. A write subagent with no `plugin:matriline/lease` record (its session log was trimmed, for example) has its `write`, `edit`, and `apply_patch` rejected fail-closed with `WRITE_SCOPE_VIOLATION` after resume; `delegate` it again.
7. A `wait: true` timeout by default only ends the wait and does not stop the subagent; the subagent keeps running, sends its result, and holds its write scope until it finishes or is explicitly stopped.
8. The authenticity of `path:line` in `findings[].evidence` is constrained only by the prompt; the code does not verify it.
9. The plugin's own data directory and package directory are protected by the write-scope guard: a leased write subagent cannot write to them (including when the task is to modify this plugin itself); the root session is not subject to this restriction and can still write.
10. Cleanup of `worktreeError` parses the worktrees service's “Any created checkout and branch are retained” text to recover the checkout path, so it depends on that wording. The repository identity is re-verified with `git rev-parse --show-toplevel`, so a wrong guess is usually a no-op; if the service's wording changes, automatic cleanup stops working and the checkout is retained.
11. The client half expects the host to provide `@deepseek-ai/dsh-client-ui-primitives`; when that module is absent it falls back to built-in controls, so behavior is unaffected but the look may differ from the official controls.

## Compatibility

- `engines.dsh` in `package.json` (`>=0.2.0-rc.1 <0.3.0`) is the declared compatibility window and the only compatibility promise; DSH rejects incompatible versions according to it.
- Tested on `0.2.2-rc.5`.
- 0.2.x hosts below the floor may still work: the plugin feature-detects host services and degrades when one is missing (see [Host dependencies and degradation](#host-dependencies-and-degradation)), but those versions are outside the supported range and are not guaranteed.
- Before upgrading to DSH 0.3.x, a plugin version that widens the compatibility window must be published first.
- Changing the compatibility window changes the promise; `engines.dsh` and this section must be updated together.

## Security and contributing

- Security policy and vulnerability reporting: [SECURITY.md](SECURITY.md)
- Development setup, tests, and release checklist: [CONTRIBUTING.md](CONTRIBUTING.md)
- Change history: [CHANGELOG.md](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE). Copyright line: `Copyright (c) 2026 wdlpiaoyi`.
