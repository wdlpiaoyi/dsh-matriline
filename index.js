/**
 * matriline — Host half.
 *
 * A delegated child currently inherits the parent's full tool surface: 76 tools,
 * ~15.7K tokens of schema = 82% of the ~19K fixed overhead of one delegation
 * (measured in a DSH 0.2.x build). A reader child needs almost none of it.
 *
 * At `agent/created` (serial, before the child's first assembly):
 *   1. restrict the child's visible tools: a fixed reader whitelist for
 *      `read`/`verify`, and {@link WRITE_MINIMAL_TOOLS} for `write` — a writer
 *      inherits the full surface only when the delegation asked for
 *      `tools: "full"` (or named its own list);
 *   2. append a read-only sandbox override for reader kinds
 *   3. optionally replace the whole system prompt with a compact reader one
 *
 * The switches that exist TODAY:
 *   - the `matriline-state` profile entry's `config.sessions` map:
 *     `{ <sessionId>: boolean }`, written by the model-menu switch (absent ⇒ ON);
 *     `state.json` under the plugin data directory is the migration fallback;
 *   - `matriline.paused` (a file): exists ⇒ the trimming gate is off for every
 *     session, whatever the settings layer says;
 *   - `matriline.noprompt` (a file): exists ⇒ do NOT replace the whole system
 *     prompt with the compact reader one; tool/sandbox trimming is unaffected;
 *   - the OFFICIAL subagent model-selection switch (`subagentModelSelection`):
 *     readable and off ⇒ `delegate` / `delegate_many` refuse an explicitly
 *     selected child model instead of silently widening to any route. That is
 *     stricter than the official tool, which still accepts the parent's own
 *     route; the refusal says so and points at the inherit path.
 *
 * A `kind` passed EXPLICITLY to this plugin's own `delegate` tool is enforced
 * unconditionally: the gate above never turns a requested reader into a writer.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The DSH home directory (`$DSH_HOME` wins, else `~/.dsh`).
 *
 * Read once at load: this plugin's bookkeeping (`state.json`, `config.json`)
 * lives under it, and one resolution rule means they can never
 * drift apart. An unreadable environment degrades to `.dsh` under the current
 * directory instead of throwing at module load.
 */
function dshHome() {
  try {
    const fromEnv = process.env.DSH_HOME
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  } catch {
    /* no environment: fall through to the home directory */
  }
  try {
    return join(homedir(), '.dsh')
  } catch {
    return join(process.cwd(), '.dsh')
  }
}

/**
 * This plugin's data directory: the log, the two switch files, and the
 * `state` / `config` JSON. Nothing here is a path baked into the
 * package, so a checkout can move and the same tree works from git or npm.
 *
 * `$MATRILINE_HOME` wins (portable installs, tests); otherwise it is
 * `<dshHome>/matriline`, i.e. `%USERPROFILE%\.dsh\matriline` on Windows.
 */
function dataHome() {
  const fromEnv = process.env.MATRILINE_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  // Legacy codename from before the public release; kept so existing shells keep working.
  const legacyHome = process.env.FISHSCHOOL_HOME
  if (typeof legacyHome === 'string' && legacyHome.trim() !== '') return legacyHome.trim()
  try {
    return join(dshHome(), 'matriline')
  } catch {
    return join(process.cwd(), '.matriline')
  }
}

const ROOT = dataHome()
/**
 * The plugin log, in the plugin's OWN data directory.
 *
 * It must never land in a user's project: everything this plugin writes belongs
 * under {@link dataHome}.
 */
const LOG = join(ROOT, 'matriline.log')

/** Rotation ceiling: a bigger `matriline.log` is renamed and a fresh one starts. */
const LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * This module's package directory: the plugin's own CODE, kept apart from the
 * data directory the same way {@link ROOT} is (a leased writer must not rewrite
 * the guard it is running under).
 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

// Create the data directory once at load so the first `log()` and the two flag
// checks have a home. A read-only install must not throw here: `log()` already
// degrades to a no-op, and a missing flag file simply means "not paused".
try {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 })
} catch {
  /* no writable data directory: keep loading anyway */
}

/**
 * Per-session switch state. Kept OUTSIDE the session log on purpose: a custom
 * session event must carry the host's `ignorable` marker or the log is refused
 * on restore. A side file has no such risk.
 */
const STATE_DIR = ROOT
const STATE_FILE = join(STATE_DIR, 'state.json')

/** User-tunable settings (`{ "contextWarnRatio": 0.8 }`); created on first write. */
const CONFIG_FILE = join(STATE_DIR, 'config.json')

/*
 * This plugin tracks NO price or capability metadata for a child route, and
 * follows the official `dsh-tool-subagent` here: the LLM service exposes only
 * `id / name / description` (no price, no context window, no ability score), so
 * there is no local price table to read and no price/cost field on a result.
 * Route selection is validated against the official registries instead of
 * against self-invented metadata.
 */

/**
 * Opt-OUT for the complete-prompt replacement (the main token win for reader
 * children). Default ON; this file exists only to turn the compact prompt OFF.
 */
const PROMPT_OFF_FLAG = join(ROOT, 'matriline.noprompt')

/**
 * Pause file: exists ⇒ the gate is off for every session, regardless of the
 * official team switch. Needed when a delegated child must be able to write
 * (the switch would otherwise trim every child to a reader).
 */
const PAUSE_FLAG = join(ROOT, 'matriline.paused')

/**
 * Last known official team-switch value, per root session.
 *
 * `agentTeams.isEnabled()` throws "agent has no active runtime owner" if it is
 * called for a freshly created child, so the value is read once on the ROOT's
 * `agent/created` and then kept current from `team/mode` session events. A child
 * creation only reads this cache.
 */
const teamDecision = new Map()

/** The root session a gate decision belongs to. */
function rootIdOf(header) {
  return header.origin === 'subagent' ? header.parentSession ?? header.id : header.id
}

/**
 * Child session id → the ROOT session id it belongs to, accumulated as children
 * appear. The runtime cannot answer this at creation time: both
 * `subagents.rootOf()` and `agentTeams.isEnabled()` throw "agent has no active
 * runtime owner" for a freshly created child. Every child passes through the
 * `agent/created` hook, so each one registers itself and a grandchild resolves
 * through its parent's entry.
 */
const rootOfSession = new Map()

/**
 * Granted kind per child session id.
 *
 * Used to stop privilege ESCALATION through delegation: a read-only child holds
 * `delegate`, so without this cap it could simply ask for a `write` grandchild
 * and do anything the sandbox allows. A child may only delegate at or below its
 * own privilege.
 */
const kindOfSession = new Map()

/**
 * The plugin-record type carrying a child's granted kind (`{ kind: "read" }`).
 *
 * SECURITY: a resumed child re-fires `agent/created` with `source: "resume"` and
 * NO dispatch slot (`send_message` wakes it, nothing re-dispatched it), while
 * {@link kindOfSession} is in-memory only and a plugin reload clears it. Without
 * a durable copy a READER came back as a WRITER (write sandbox + the minimal
 * writer tool set) the moment it was woken. The record is written ONCE, on the
 * first creation, through `appendPluginRecord` — a `plugin:*` type is
 * automatically `ignorable`, so the log still restores.
 */
const KIND_EVENT_TYPE = 'plugin:matriline/kind'

/**
 * The plugin-record type carrying a child's tools profile
 * (`{ mode: "minimal" | "full" | "names", names?: [...] }`).
 *
 * The SAME resume gap as {@link KIND_EVENT_TYPE}, one field over: a writer created
 * by `delegate(kind="write", tools="full")` was woken by `send_message`, which
 * re-fires `agent/created` with no dispatch slot at all. {@link pendingTools} is
 * deleted in the dispatch's `finally`, so the resumed child resolved
 * `resolveToolsProfile(undefined)` = `minimal` and was silently cut from the
 * inherited 77 tools to 13 (the writer whitelist) with no hint to the caller.
 * The record makes the decision as durable as the kind.
 */
const TOOLS_EVENT_TYPE = 'plugin:matriline/tools'

/**
 * The plugin-record type carrying a child's `skills` decision
 * (`{ skills: true | false }`) — the last of the three dispatch-time fields to
 * become durable, symmetric with {@link KIND_EVENT_TYPE} / {@link TOOLS_EVENT_TYPE}.
 *
 * The SAME resume gap, one field over: `pendingSkills` is a per-dispatch slot
 * deleted in `startChild`'s `finally`, so `send_message` re-fires `agent/created`
 * with nothing to read. The old strip rule then let a preserved `tools:"full"`
 * profile escape the `skill` deny entirely, so the woken child came back with
 * `skill` and its ~3,000-character catalog: request #1 had 78 tools, request #2
 * had 79 for the same child. The record makes `skills` as durable as the two
 * fields next to it. `plugin:` prefix ⇒ the record is `ignorable`.
 */
const SKILLS_EVENT_TYPE = 'plugin:matriline/skills'

/**
 * The plugin-record type carrying a delegated writer's write-scope LEASE
 * (`{ leased: true, scopes: [{ value, dir, raw }], isolate, worktree? }`, or
 * `{ leased: false }` for a write child this plugin never leased).
 *
 * The SAME resume gap as `kind`/`tools`/`skills`, one security tier down: the
 * lease lives only in the in-memory `writeLeases` map. `send_message` re-fires
 * `agent/created` on a child that ended long ago — its lease was released on
 * `subagent/end` — so the woken writer came back with NO entry at all, and the
 * Tier 2 guard deliberately passes any caller without one (`own === undefined`,
 * the root/read case). A resumed writer could therefore write into another
 * child's leased files, which is exactly what the lease exists to prevent. The
 * record makes the claim as durable as the kind; its absence is a refusal for a
 * plugin-managed writer instead of a silent bypass.
 */
const LEASE_EVENT_TYPE = 'plugin:matriline/lease'

/**
 * Tools profile per child session id — the in-memory tier of the resume fix
 * (mirrors {@link kindOfSession}). A miss is backfilled from the child's own
 * {@link TOOLS_EVENT_TYPE} record and then kept here for the next resume.
 */
const toolsOfSession = new Map()

/**
 * `skills` per child session id — the in-memory tier, exactly like
 * {@link toolsOfSession}. A miss is backfilled from the child's own
 * {@link SKILLS_EVENT_TYPE} record, so a resumed child keeps `skill` only when
 * it was granted `skills: true` on its FIRST creation.
 */
const skillsOfSession = new Map()

/** Privilege rank per kind; a child may not delegate above its own rank. */
const KIND_RANK = { read: 0, verify: 0, write: 1 }

/**
 * The ROOT session a created agent belongs to.
 *
 * The in-memory map is only a cache: it is empty after a plugin reload, and a
 * resumed child then resolves to its immediate parent (a child), whose id was
 * never registered — which silently turns the gate off and leaves a resumed
 * grandchild untrimmed. So fall back to walking the durable session headers.
 */
function resolveRoot(ctx, header) {
  if (header.origin !== 'subagent') return header.id
  let current = header
  let guard = 0
  while (current?.parentSession !== undefined && guard < 16) {
    guard += 1
    const cached = rootOfSession.get(current.parentSession)
    if (cached !== undefined) return cached
    let parent
    try {
      parent = ctx.get('sessions')?.get?.(current.parentSession)
    } catch (error) {
      parent = undefined
    }
    if (parent?.header === undefined) return current.parentSession
    current = parent.header
  }
  return current?.id ?? header.id
}

/** The config layer's explicit choices, mirrored here for synchronous gate reads. */
const sessionChoice = new Map()

/**
 * The explicit per-session choice, or undefined when the user never made one.
 *
 * The `matriline-state` store is authoritative once loaded; `state.json` is
 * the pre-state-entry / migration fallback. Absent means the default (ON).
 */
function stateOn(sessionId) {
  if (sessionChoice.has(sessionId)) return sessionChoice.get(sessionId)
  // `Object.hasOwn`: a session id that happens to be a prototype key ("toString",
  // "constructor") must read as "never chosen", not as an inherited function.
  const state = readState()
  if (!Object.hasOwn(state, sessionId)) return undefined
  const entry = state[sessionId]
  return entry === undefined ? undefined : entry.enabled === true
}

/** Remove the explicit choice (config side and state.json) for one session. */
function clearOn(sessionId) {
  const state = readState()
  if (Object.hasOwn(state, sessionId)) {
    delete state[sessionId]
    writeState(state)
  }
}

/** The well-formed `sessions` map of a state snapshot. */
function configSessions(value) {
  const sessions = {}
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.sessions : undefined
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [id, enabled] of Object.entries(source)) {
      if (typeof id === 'string' && id !== '' && typeof enabled === 'boolean') sessions[id] = enabled
    }
  }
  return sessions
}

/**
 * Whether trimming applies to one agent, and which gate decided it.
 *
 * `source` names the switch that decided it: `paused` (the pause file),
 * `session` (the explicit per-session choice) or `default`.
 *
 * Precedence: pause file > explicit session choice > default ON. The official
 * Team switch is a separate control and never changes trimming.
 *
 * `rootSessionId` must be the ROOT session, not the immediate parent: a
 * grandchild's `parentSession` is its own parent (a child), whose id was never
 * cached, so using it would read as "gate off" and silently skip trimming.
 */
function gateFor(header, rootSessionId) {
  if (existsSync(PAUSE_FLAG)) return { on: false, source: 'paused' }
  const rootId = rootSessionId ?? rootIdOf(header)
  const explicit = stateOn(rootId)
  // Default ON. The official Team switch is a separate control; only the
  // settings layer (the model-menu switch) can turn trimming off.
  return explicit === undefined
    ? { on: true, source: 'default' }
    : { on: explicit, source: 'session' }
}

/**
 * The subset of `names` that `tools.restrict` can accept for one agent scope.
 *
 * `restrict` throws on a name it does not know, and a throwing `agent/created`
 * listener fails the whole agent creation, so the deny list is filtered first:
 *
 *   - `tools.get(name, agent)` answers "is this name registered and visible to
 *     this scope at all" (the global view ALSO answers, so a scoped name is not
 *     mistaken for an unknown one);
 *   - when no probe can answer, the name is kept and `restrict` itself decides —
 *     the caller catches, so the only downside of a wrong guess is a log line.
 *
 * This plugin's own delegation entry points are never filtered out: hiding
 * `delegate` / `delegate_many` would leave the session with no way to delegate.
 */
function filterDeniableTools(agent, names) {
  const { present, scoped, isVisible } = toolVisibility(agent)
  if (!present) return []
  const kept = []
  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue
    if (name === 'delegate' || name === 'delegate_many') {
      log(`surface: ${name} is this plugin's own entry point — never denied`)
      continue
    }
    const registered = isVisible(name)
    if (registered === true || scoped?.has(name) === true) {
      kept.push(name)
      continue
    }
    if (registered === undefined && scoped === undefined) {
      // No probe could answer; keep the name and let `restrict` rule on it.
      kept.push(name)
      continue
    }
    log(`surface: ${name} is not a visible tool in this session — left out of the deny list`)
  }
  return kept
}

/**
 * The two probes {@link filterDeniableTools} / {@link intersectVisibleTools} use.
 *
 * `scoped` is the agent's own visible listing; `isVisible(name)` asks the registry
 * for that name in THIS scope and answers `undefined` when no probe could decide.
 * Both are shared so an allow list and a deny list can never disagree about what
 * "visible here" means.
 */
function toolVisibility(agent) {
  const tools = agent?.ctx?.tools
  const present = tools !== undefined && tools !== null
  let scoped
  if (present) {
    try {
      const definitions = typeof tools.definitions === 'function' ? tools.definitions(agent) : undefined
      if (Array.isArray(definitions)) {
        scoped = new Set(
          definitions.map(definition => definition?.name).filter(name => typeof name === 'string'),
        )
      }
    } catch (error) {
      log(`surface: scoped tool listing FAILED: ${error?.message}`)
    }
  }
  const isVisible = (name) => {
    if (!present) return undefined
    try {
      return typeof tools.get === 'function' ? tools.get(name, agent) !== undefined : undefined
    } catch (error) {
      log(`surface: tools.get(${name}) FAILED: ${error?.message}`)
      return undefined
    }
  }
  return { present, scoped, isVisible }
}

/**
 * The requested tool names that are actually VISIBLE to one agent.
 *
 * `restrict({ allow })` throws on a name this deployment does not register
 * (`apply_patch` / `bash` are optional), and a throwing `agent/created` listener
 * fails the whole child creation — the exact failure this intersection prevents.
 * A name no probe can answer for is KEPT and left to `restrict` itself (the caller
 * catches, so the worst case is an untrimmed child, never a dead one).
 */
function intersectVisibleTools(agent, names) {
  const { scoped, isVisible } = toolVisibility(agent)
  const kept = []
  const seen = new Set()
  for (const name of names) {
    if (typeof name !== 'string' || name === '' || seen.has(name)) continue
    seen.add(name)
    const registered = isVisible(name)
    if (registered === true || scoped?.has(name) === true) {
      kept.push(name)
      continue
    }
    if (registered === undefined && scoped === undefined) {
      kept.push(name)
      continue
    }
    log(`tools: ${name} is not a visible tool in this session — skipped`)
  }
  return kept
}

/**
 * The read-only tools a fail-safe fallback may hand a child whose requested set
 * is invisible in this deployment.
 *
 * `KIND_TOOLS.read` is the normal reader set; this is the subset that survives
 * even the most exotic preset. A reader that loses `list_agents` / `delegate`
 * is still useful; a reader that silently keeps the parent's write surface is
 * the failure this fallback exists to prevent.
 */
const SAFE_READ_TOOLS = ['read', 'grep', 'glob', 'read_image']

/**
 * Tools a fail-safe DENY removes when no allow list can be built at all.
 *
 * `delegate` / `delegate_many` are deliberately absent: `filterDeniableTools`
 * refuses to deny this plugin's own delegation entry points, and a child that
 * still holds `delegate` cannot escalate (its own calls pass the kind check).
 * The official `subagent` / `subagent_fork` are included because a writer must
 * not regain the untrimmed, dumber delegator.
 */
const SURFACE_FALLBACK_DENY_TOOLS = ['write', 'edit', 'apply_patch', 'pwsh', 'bash', 'subagent', 'subagent_fork']

/**
 * session id -> `{ agent, dispose, source }`: the exact disposer returned by the
 * delegation-surface `restrict({ deny })` this process applied to that agent.
 *
 * `tools.restrict()` attaches its effect to `agent.ctx` (the restricted agent's
 * OWN fiber), not to this plugin, which has two consequences:
 *   - a plugin reload does NOT lift the restriction: the map dies with the
 *     plugin while the old deny survives on the still-live agent, so
 *     turning the switch off can only report that the host must be restarted or a
 *     new session opened;
 *   - the restriction lifts by itself when the agent is disposed, which is why
 *     the cleanup below is map hygiene rather than a correctness step.
 */
const surfaceDisposers = new Map()

/**
 * The visible part of `requested`, with a safe read fallback.
 *
 * Returns the names to pass to `restrict({ allow })`, or `null` when NOTHING
 * visible is left. A `null` answer is the caller's signal to apply
 * {@link denyFallbackSurface} instead of inheriting the parent's surface.
 */
function chooseAllowTools(agent, requested, fallbackRequested) {
  const visible = intersectVisibleTools(agent, requested)
  if (visible.length > 0) return visible
  if (fallbackRequested !== undefined) {
    const fallback = intersectVisibleTools(agent, fallbackRequested)
    if (fallback.length > 0) {
      log(`tools: requested set is invisible here — fell back to [${fallback.join(', ')}]`)
      return fallback
    }
  }
  const safe = intersectVisibleTools(agent, SAFE_READ_TOOLS)
  if (safe.length > 0) {
    log(`tools: no requested/fallback tool is visible here — fail-safe to [${safe.join(', ')}]`)
    return safe
  }
  return null
}

/**
 * Fail-safe deny for a child whose allow list could not be applied.
 *
 * STRICTLY better than the old "left inherited": the deny list is filtered to
 * the names `restrict` can accept, so a missing optional tool cannot throw.
 * When even the filtered list is empty the surface is logged as UNTRIMMED and
 * keeps the parent's tools — there is no further public seam to close.
 */
function denyFallbackSurface(agent, sessionId, reason) {
  try {
    const deny = filterDeniableTools(agent, SURFACE_FALLBACK_DENY_TOOLS)
    if (deny.length === 0) {
      log(`surface: no fail-safe deny is restrictable for session=${sessionId} (${reason}); surface left UNTRIMMED`)
      return false
    }
    agent.ctx.tools.restrict({ deny })
    log(`surface: fail-safe deny [${deny.join(', ')}] for session=${sessionId} (${reason})`)
    return true
  } catch (error) {
    log(`surface: fail-safe deny FAILED for session=${sessionId} (${reason}); surface left UNTRIMMED: ${error?.message}`)
    return false
  }
}

/**
 * Whether the official delegation tool is absent, visible, or masked IN THIS
 * SCOPE right now.
 *
 * Turning the switch off needs this because "no disposer" means two very different
 * things: nothing was ever restricted here (nothing to do), or a PREVIOUS plugin
 * load restricted the agent and its disposer is gone — the old deny is still in
 * force and only a host restart / new session can lift it.
 * `tools.view(scope).knownNames` is the pre-restriction registry view, so
 * "registered but not visible" is the mask signal.
 */
function delegationToolMaskState(agent) {
  try {
    const tools = agent?.ctx?.tools
    if (tools === undefined || tools === null || typeof tools.view !== 'function') return 'unknown'
    const view = tools.view(agent)
    const known = view?.knownNames
    const visible = view?.visible
    if (typeof known?.has !== 'function' || typeof visible?.has !== 'function') return 'unknown'
    for (const name of ['subagent', 'subagent_fork']) {
      if (known.has(name) !== true) continue
      return visible.has(name) === true ? 'visible' : 'masked'
    }
    return 'absent'
  } catch (error) {
    log(`surface: mask probe FAILED: ${error?.message}`)
    return 'unknown'
  }
}

/** Release the delegation-surface restriction this process applied, if any. */
function releaseSurfaceRestriction(sessionId, reason) {
  const key = String(sessionId)
  const entry = surfaceDisposers.get(key)
  if (entry === undefined) return false
  surfaceDisposers.delete(key)
  try {
    dismiss(entry.dispose)
    log(`surface: released for session=${key} (${reason})`)
    return true
  } catch (error) {
    log(`surface: release FAILED for session=${key} (${reason}): ${error?.message}`)
    return false
  }
}

/**
 * Converge the model-visible delegation surface of ONE root agent.
 *
 * Two entry points share this body, because a Session gets exactly one chance
 * per creation and an already-existing one never fires `agent/created` again:
 *   - `created` — the root branch of the `agent/created` hook;
 *   - `primed`  — the `apply()` preheat loop over the live agents, so sessions
 *     that outlived this plugin load are converged too.
 *
 * The returned disposer is the exact one `restrict` handed back (owned by the
 * restricted agent's fiber) and is kept in {@link surfaceDisposers} so
 * turning the switch off can lift the exact restriction instead of guessing.
 *
 * Never throws: the caller may be a serial `agent/created` listener (where an
 * exception rejects the whole agent creation) or `apply()` itself.
 */
function restrictDelegationSurface(agent, sessionId, source) {
  try {
    const deny = filterDeniableTools(agent, ['subagent', 'subagent_fork'])
    if (deny.length === 0) {
      log(`surface: skipped (no restrictable official delegation tool) for session=${sessionId} (${source})`)
      return undefined
    }
    const key = String(sessionId)
    const previous = surfaceDisposers.get(key)
    // Apply the NEW restriction first: if it throws, the one already in force
    // stays untouched instead of being lifted into an untrimmed surface.
    const dispose = agent.ctx.tools.restrict({ deny })
    if (typeof dispose !== 'function') {
      // Hosts older than 0.2.2-rc.5 may not return a disposer; the deny IS in
      // force, but it cannot be tracked or lifted, and turning the switch off must not claim it
      // was. Recording nothing sends that command down the "masked, restart"
      // branch instead of a false success.
      log(`surface: restrict returned no disposer for session=${sessionId} (${source}) — the switch cannot lift it`)
      return undefined
    }
    if (previous !== undefined) {
      surfaceDisposers.delete(key)
      dismiss(previous.dispose)
    }
    surfaceDisposers.set(key, { agent, dispose, source })
    log(`surface: denied [${deny.join(', ')}] for session=${sessionId} (${source})`)
    return dispose
  } catch (error) {
    log(`surface: restrict FAILED for session=${sessionId} (${source}, delegation surface unchanged): ${error?.message}`)
    return undefined
  }
}

/**
 * Re-converge ONE live delegated child after a plugin reload.
 *
 * `agent/created` never fires again for a session that outlived the plugin, so
 * without this a child created before this plugin was loaded (or by a version
 * that did not trim) keeps the untrimmed surface forever. The three dispatch-time
 * decisions are READ BACK from their durable records — this function never
 * appends a record (`recordKindOnce` / `recordToolsOnce` / `recordSkillsOnce`
 * stay creation-only) and never changes a recorded value.
 *
 * FAIL-SAFE: a child with no kind record is an official `subagent` child (or one
 * created while the gate was off). With the gate ON it is converged to the
 * reader minimum and logged; with the gate OFF it is left alone, because "gate
 * off" is the explicit request to leave children untrimmed. A `tools:"full"`
 * profile is likewise left inherited — it was an explicit request.
 */
function replayChildSurface(ctx, agent, session, header, sessionId) {
  const rememberedKind = kindOfSession.get(sessionId)
  const durableKind = Object.hasOwn(KIND_RANK, rememberedKind)
    ? rememberedKind
    : kindFromSessionLog(ctx, sessionId, session)
  const kindKnown = Object.hasOwn(KIND_RANK, durableKind)
  if (!kindKnown) {
    let gate
    try {
      gate = gateFor(header, resolveRoot(ctx, header))
    } catch (error) {
      gate = { on: false, source: `gate-error: ${error?.message}` }
    }
    if (!gate.on) {
      log(`surface: prime child=${sessionId} has no kind record and the gate is ${gate.source} — left untrimmed (nothing was requested)`)
      return
    }
    log(`surface: prime child=${sessionId} has no kind record — fail-safe to kind="read" (gate=${gate.source})`)
  }
  const kind = kindKnown ? durableKind : 'read'
  const cachedSkills = skillsOfSession.get(sessionId)
  const skills = typeof cachedSkills === 'boolean'
    ? cachedSkills
    : skillsFromSessionLog(ctx, sessionId, session) ?? false

  let appliedTools = null
  let trimRequested = true
  if (kind === 'write') {
    const cachedProfile = asResolvedToolsProfile(toolsOfSession.get(sessionId))
    const profile = cachedProfile
      ?? toolsProfileFromSessionLog(ctx, sessionId, session)
      ?? resolveToolsProfile(undefined, ` (prime child ${sessionId})`)
    if (profile.mode === 'full') {
      trimRequested = false
      log(`surface: prime child=${sessionId} tools profile "full" — left inherited (explicit request)`)
    } else {
      const requested = profile.mode === 'list' ? [...profile.names] : [...WRITE_MINIMAL_TOOLS]
      if (skills) {
        requested.push('skill')
      } else {
        while (requested.includes('skill')) requested.splice(requested.indexOf('skill'), 1)
      }
      appliedTools = chooseAllowTools(
        agent,
        requested,
        profile.mode === 'list' ? WRITE_MINIMAL_TOOLS : SAFE_READ_TOOLS,
      )
    }
  } else {
    const fixed = Object.hasOwn(KIND_TOOLS, kind) ? KIND_TOOLS[kind] : KIND_TOOLS.read
    if (fixed !== null) appliedTools = chooseAllowTools(agent, fixed, SAFE_READ_TOOLS)
  }

  let allowApplied = false
  if (appliedTools !== null) {
    try {
      agent.ctx.tools.restrict({ allow: appliedTools })
      allowApplied = true
      log(`surface: prime child=${sessionId} allow -> [${appliedTools.join(', ')}]`)
    } catch (error) {
      log(`surface: prime child=${sessionId} restrict(allow) FAILED: ${error?.message}`)
    }
  }
  if (trimRequested && !allowApplied) {
    denyFallbackSurface(agent, sessionId, 'prime-child-fallback')
  }
  if (skills !== true) {
    try {
      const skillDeny = filterDeniableTools(agent, ['skill'])
      if (skillDeny.length > 0) {
        agent.ctx.tools.restrict({ deny: skillDeny })
        log(`surface: prime child=${sessionId} skill stripped`)
      }
    } catch (error) {
      log(`surface: prime child=${sessionId} skill suppression FAILED: ${error?.message}`)
    }
  }
  const sandbox = Object.hasOwn(KIND_SANDBOX, kind) ? KIND_SANDBOX[kind] : 'read-only'
  try {
    // Re-appending the same mode is harmless for the surface; when the child
    // predates this plugin this is the append that gives it the right sandbox.
    agent.session.append('sandbox/mode', { mode: sandbox, source: 'delegation' })
    log(`surface: prime child=${sessionId} sandbox -> ${sandbox}`)
  } catch (error) {
    log(`surface: prime child=${sessionId} sandbox append FAILED: ${error?.message}`)
  }
}

/**
 * Delegation guidance injected into a SESSION's own prompt (the root agent), not
 * into children.
 *
 * Deliberately policy-only: the tool SCHEMAS already say how each parameter
 * behaves (kind semantics, `model`, `name`, `reconcile`, …), so this text says
 * WHEN to delegate and adds only what a schema cannot — the deployment's own
 * "delegate freely / never block for 30 s" calibration.
 */
const TRIGGER_TEXT = [
  'Delegation here is cheap and kind-aware: `delegate(task, kind)`, and `delegate_many` for batches,',
  'are the only delegation entry points (the official `subagent` / `subagent_fork` are hidden).',
  '',
  'WHEN to delegate (rules, not suggestions):',
  '1. Multi-step, long-running, or "write a whole file / restructure a document / audit N files" work',
  '   MUST be delegated instead of done inline. Do it without being asked.',
  '2. Work that will take more than ~30 seconds: pass `wait:false` and keep this conversation moving —',
  '   the child reports back as a message. NEVER sit blocked on a long delegation.',
  '3. `wait:true` only for short reads whose answer you need in the very next step.',
  '4. THREE or more INDEPENDENT sub-tasks go through ONE `delegate_many` call (maxConcurrent 3-5),',
  '   not N `delegate` calls; repeated single delegations are for a chain that depends on the previous',
  '   answer. Ask the batch to `reconcile` when every task answers the same question.',
  '5. A write child gets a MINIMAL tool set by default (file, shell, search + `delegate`). When the',
  '   task needs a heavier tool (`plugin_manager`, `schedule_*`, the sidebar browser, `workflow`, …),',
  '   say so in the same call — `tools:"full"` or the explicit names — or it has no such tool.',
  '6. 真有争议、需要多方专业视角互相挑错时（方案选择、审计结论互斥、评审分歧）用 `deliberate`：',
  '   N 个只读参与者独立给立场，第 2 轮把彼此立场回灌给同一个子代理续跑，最后合成 consensus/分歧。',
  '   不要用它代替普通的批量读取——成本是 N×(rounds+1) 次请求，比 `delegate_many` 更慢更贵。',
  '',
  'Keep decisions, writes and final review in this session; every child needs a self-contained brief',
  '(background, task, boundary, deliverable, what to do when blocked).',
].join('\n')

/**
 * The kind of the delegation currently being started by this plugin's own
 * `delegate` tool, per parent session.
 *
 * The child is created INSIDE `startActivation`, so `agent/created` fires before
 * that call returns and cannot learn the kind any other way. The slot is set
 * immediately before the call and cleared in `finally`; the hook consumes it.
 */
const pendingKind = new Map()

/** Whether the child being started asked to keep the `skill` tool (and catalog). */
const pendingSkills = new Map()

/**
 * The tools profile a child was started with (`{ mode: 'minimal' | 'full' | 'list' }`),
 * per parent session, consumed by that child's `agent/created` hook exactly like
 * {@link pendingKind}. Set and cleared inside the same per-parent slot window, so
 * two overlapping starts cannot cross their profiles. An entry of `undefined`
 * means "no explicit request" — the write default (`minimal`) applies.
 *
 * A NEW dispatch always wins, but the `finally` that clears this slot means a
 * resumed child (`send_message`) finds it empty: the durable tiers are
 * {@link toolsOfSession} and the child's own {@link TOOLS_EVENT_TYPE} record.
 */
const pendingTools = new Map()

/**
 * The write-lease reservation of the child being started, per parent session.
 *
 * The lease OBJECT cannot reach the child's own `agent/created` hook any other
 * way: the child is created INSIDE `startActivation`, so that hook fires before
 * `startChild` can promote the lease. Carried through a slot, the hook can write
 * the reservation into the child's OWN log (the durable half of the resume fix),
 * while the lease object stays the one source of truth for the scopes. Cleared in
 * the same `finally` as the other slots; a resumed child finds it empty and reads
 * the record back instead.
 */
const pendingLeaseRecords = new Map()

/**
 * Per-parent FIFO mutex around the kind slot.
 *
 * `pendingKind` is ONE slot per parent, so "set slot → startActivation (which
 * creates the child and fires `agent/created` before it returns) → clear slot"
 * must never overlap for one parent: two overlapping starts would cross their
 * kinds and hand a write child a reader's tool set (or the reverse). Both
 * `delegate` and `delegate_many` take this lock, and they SHARE it, which is
 * what keeps the two tools from racing each other. Only the start window is
 * inside the lock — waiting for a child never is.
 *
 * Known residual, unchanged by declaring both tools parallel-safe: the slot is
 * bound to the PARENT, so a child of the same parent created by ANOTHER tool (the
 * official `subagent`, which is also parallel-safe) would consume it. The window
 * is a few milliseconds and `subagent` is hidden from root sessions, so this is
 * accepted (not locked): a real fix needs a creator identity that the
 * `agent/created` payload does not carry.
 */
const kindQueues = new Map()

/**
 * The FIXED tool whitelist per kind. `null` means "no whitelist is baked in for
 * this kind" — for `write` that is no longer "inherit everything": the `tools`
 * profile decides (see {@link WRITE_MINIMAL_TOOLS}).
 */
const KIND_TOOLS = {
  read: ['read', 'grep', 'glob', 'read_image', 'list_agents', 'send_message', 'delegate', 'cancel_subagent'],
  write: null,
  verify: ['read', 'grep', 'glob', 'read_image', 'list_agents', 'send_message', 'delegate', 'cancel_subagent'],
}

/**
 * The DEFAULT tool set of a `kind="write"` child (`tools: "minimal"`).
 *
 * A writer used to inherit the parent's whole surface — measured on a real child:
 * 77 tools, ~76K characters of schema — to call ~6 of them (`read`, `pwsh`,
 * `edit`, `grep`, `write`, `send_message`), i.e. ~9% used and the rest a per-request
 * tax. This is what a writer genuinely needs: file I/O, one shell, search, its own
 * delegation, todo and the web.
 *
 * It is INTERSECTED with the tools visible to the child before `restrict({allow})`
 * (see {@link intersectVisibleTools}): `apply_patch` and `bash` are not registered
 * in every deployment, and `restrict` throws on an unknown name — which would fail
 * the whole child creation. `tools: "full"` opts back into the inherited set; a
 * name array replaces this list (still intersected).
 */
const WRITE_MINIMAL_TOOLS = [
  'read', 'write', 'edit', 'apply_patch', 'grep', 'glob', 'read_image',
  'pwsh', 'bash',
  'delegate', 'cancel_subagent', 'send_message', 'todo_write', 'working_directory',
  'web_fetch', 'web_search',
]

/**
 * Delegation guidance for a CHILD that holds `delegate`.
 *
 * Root sessions get {@link TRIGGER_TEXT}; children get this shorter one, because
 * a child's own system prompt is otherwise untouched (or replaced by the compact
 * reader prompt) and nothing would ever tell it that it may fan out.
 */
const CHILD_TRIGGER_TEXT = [
  'You may hand sub-tasks to your own children with `delegate(task, kind)`; `kind="read"` is the cheap',
  'read-only default. Delegate only when a sub-task needs reading many files or an independent check —',
  'otherwise do it yourself, and keep the final judgement in your own hands.',
  '',
  'If the task needs a tool you do not have, name the missing tool in your conclusion so the parent can',
  're-delegate with `tools`; do NOT work around it yourself.',
  'Never request a sandbox escalation (`sandbox_permissions`): a delegated child runs with fixed',
  'permissions, so report the refusal and its exact error instead of retrying or widening the path.',
  '',
  'If `delegate` fails because the subagent slots are full (concurrency/quota), do NOT retry in a loop:',
  'finish the work yourself and say in your answer that you hit the slot limit.',
].join('\n')

/** Sandbox mode per delegation kind. */
const KIND_SANDBOX = {
  read: 'read-only',
  write: 'workspace-write',
  verify: 'read-only',
}

/** Append one timestamped line; never throw. Rotates over {@link LOG_MAX_BYTES}. */
function log(message) {
  try {
    try {
      const size = statSync(LOG).size
      if (size > LOG_MAX_BYTES) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        let rotated = `${LOG}.${stamp}`
        for (let attempt = 2; existsSync(rotated) && attempt < 100; attempt += 1) {
          rotated = `${LOG}.${stamp}-${attempt}`
        }
        renameSync(LOG, rotated)
      }
    } catch {
      /* a missing log is the normal first write */
    }
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* the plugin must not break the host over its own bookkeeping */
  }
}

/**
 * Normalize one delegation's `tools` argument into a profile.
 *
 * Three shapes, one result:
 *   - `"minimal"` (also the DEFAULT, i.e. an absent value) → {@link WRITE_MINIMAL_TOOLS};
 *   - `"full"` → no trimming at all (the pre-change write behavior);
 *   - a string array → exactly those names (still intersected with the visible set).
 *
 * An UNUSABLE value (a number, an object, an empty array, an unknown string) is
 * NOT an error: it degrades to `minimal` and is logged, because refusing a whole
 * delegation over a cosmetic field would be worse than trimming it.
 * `where` only decorates the log line (` (delegate_many[2])`).
 */
function resolveToolsProfile(value, where = '') {
  try {
    // An already-resolved profile passes through: the `delegate` tool resolves
    // the caller's raw argument once and hands `{ mode }` to the child hook
    // through the slot, so this function may be reached with either shape.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (value.mode === 'full' || value.mode === 'minimal') return { mode: value.mode }
      if (value.mode === 'list' && Array.isArray(value.names)) return resolveToolsProfile(value.names, where)
    }
    if (Array.isArray(value)) {
      const names = value
        .filter(name => typeof name === 'string')
        .map(name => name.trim())
        .filter(name => name !== '')
      if (names.length > 0) return { mode: 'list', names }
      log(`tools${where}: an empty name array is not usable — using "minimal"`)
      return { mode: 'minimal' }
    }
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase()
      if (text === 'full') return { mode: 'full' }
      if (text === 'minimal' || text === '') return { mode: 'minimal' }
      log(`tools${where}: ${JSON.stringify(value)} is not "minimal", "full" or a name array — using "minimal"`)
      return { mode: 'minimal' }
    }
    if (value === undefined) return { mode: 'minimal' }
    log(`tools${where}: a ${value === null ? 'null' : typeof value} is not "minimal", "full" or a name array — using "minimal"`)
    return { mode: 'minimal' }
  } catch (error) {
    log(`tools${where}: profile parse FAILED (${error?.message}) — using "minimal"`)
    return { mode: 'minimal' }
  }
}

// ---------------------------------------------------------------------------
// `config.json` — user-tunable settings with a forgiving read path
//
// The file is optional and hand-edited, so every failure mode has ONE meaning:
// "not configured". Missing file, broken JSON, a value that is not a number, or
// a number outside `(0, 1]` all fall back to the default ratio silently — an
// unreadable setting must never turn a delegation into an error, and a typo
// must never disable the warning (the safe direction is to warn at 0.8).
//
// Read cost is bounded twice: a 5 s TTL, and the file's mtime. Editing the file
// changes the mtime, so a fresh value is visible on the very next settle (even
// inside the TTL window) without any invalidation handshake.
// ---------------------------------------------------------------------------

/** Warn when the last request's prompt reaches this fraction of the window. */
const DEFAULT_CONTEXT_WARN_RATIO = 0.8
/** Upper bound on re-reading the config, even when the file did not change. */
const CONFIG_CACHE_MS = 5_000

/** `{ at, mtimeMs, value }` — the last successful (or defaulted) resolution. */
let configCache = { at: 0, mtimeMs: undefined, value: { contextWarnRatio: DEFAULT_CONTEXT_WARN_RATIO } }

/**
 * A usable warn ratio, or undefined. `(0, 1]` only: 0 or a negative value would
 * warn on every child (and every ratio is `>= 0`, so 0 is a permanent warning),
 * and a value above 1 can never be reached, i.e. it would silently mean "off".
 */
function normalizeWarnRatio(value) {
  try {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    if (value <= 0 || value > 1) return undefined
    return value
  } catch {
    return undefined
  }
}

/** The single field this plugin reads, with the default for anything unusable. */
function normalizeConfig(parsed) {
  const ratio = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? normalizeWarnRatio(parsed.contextWarnRatio)
    : undefined
  return { contextWarnRatio: ratio ?? DEFAULT_CONTEXT_WARN_RATIO }
}

/** The effective settings, from the mtime/TTL cache or a fresh read. Never throws. */
function readConfig() {
  try {
    let mtimeMs
    try {
      mtimeMs = statSync(CONFIG_FILE).mtimeMs
    } catch {
      mtimeMs = undefined
    }
    const cached = configCache
    if (cached.at !== 0 && cached.mtimeMs === mtimeMs && Date.now() - cached.at < CONFIG_CACHE_MS) {
      return cached.value
    }
    let value = { contextWarnRatio: DEFAULT_CONTEXT_WARN_RATIO }
    if (mtimeMs !== undefined) {
      try {
        value = normalizeConfig(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')))
      } catch (error) {
        // Broken JSON keeps the default; it is logged once per actual re-read.
        log(`config: ${CONFIG_FILE} unreadable (using ${DEFAULT_CONTEXT_WARN_RATIO}): ${error?.message}`)
      }
    }
    configCache = { at: Date.now(), mtimeMs, value }
    return value
  } catch (error) {
    log(`config read FAILED (using ${DEFAULT_CONTEXT_WARN_RATIO}): ${error?.message}`)
    return { contextWarnRatio: DEFAULT_CONTEXT_WARN_RATIO }
  }
}

/** The effective context-warn ratio. Never throws. */
function contextWarnRatio() {
  try {
    return normalizeWarnRatio(readConfig().contextWarnRatio) ?? DEFAULT_CONTEXT_WARN_RATIO
  } catch {
    return DEFAULT_CONTEXT_WARN_RATIO
  }
}

/** Current state map: `{ [sessionId]: { enabled } }`. */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist the state map; a failed write is logged, never thrown. */
function writeState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    // Write-then-rename: a torn or partial `state.json` would lose every explicit
    // per-session choice, so the visible file is always a complete rename.
    const temp = `${STATE_FILE}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, STATE_FILE)
  } catch (error) {
    log(`state write FAILED: ${error?.message}`)
  }
}

/** Turn trimming on or off for one session. */
function setOn(sessionId, enabled) {
  const state = readState()
  const entry = { enabled, at: Date.now() }
  // `Object.hasOwn` + `defineProperty`: a plain `state[sessionId] = entry` would
  // replace the map's prototype for an id of "__proto__" instead of adding an
  // entry, and an inherited key must be overwritten, never followed.
  if (Object.hasOwn(state, sessionId)) state[sessionId] = entry
  else Object.defineProperty(state, sessionId, { value: entry, enumerable: true, writable: true, configurable: true })
  writeState(state)
}

export const name = 'matriline'

/** Tool registry, prompt registry, projection registry. Settings is optional. */
export const inject = ['tools', 'systemPrompt', 'sessionProjections']

/**
 * Pure helpers exposed for the test suite only. They are NOT part of the plugin
 * contract: names and shapes may change without notice.
 */
export const __test = {
  KIND_RANK,
  normalizeScopePath,
  scopeCovers,
  scopesOverlap,
  resolveWriteScopes,
  pathArgumentsOf,
  pluginProtectedScopes,
}

/**
 * Permissive schema stub. A session projection declares Zod schemas, and this
 * plugin is plain JS loaded from outside the host bundle; it only ever folds and
 * forwards plain JSON, so validating here would add nothing. If the framework
 * insists on a real ZodType this registration fails loudly and is logged.
 */
const LENIENT = {
  parse: value => value,
  safeParse: value => ({ success: true, data: value }),
}

// ---------------------------------------------------------------------------
// `delegate` result contract
//
// `wait: true` (default) waits for the child to settle and answers with a
// structured status derived from the CHILD's own session log — never from the
// child's wording (the child run's final state). Two settlement channels race each other and a
// deadline: the `subagent/end` event (`SubagentRunEndInfo` carries `runId`,
// `provider`, `parentSessionId`, `id` = the child session, `local`,
// `stopReason`, `lastAssistantMessage`) and the activation's own `result`
// promise (`SubagentResult`: `output`, `structured`, `diagnostic`,
// `stopReason`). Whichever reports first wins; every listener is detached
// before the answer is built, so nothing leaks. No polling anywhere.
// ---------------------------------------------------------------------------

/** Every status this tool may return. */
const STATUSES = ['ok', 'partial', 'denied', 'error', 'timeout', 'interrupted', 'depth-exhausted', 'running']

/** Every status `cancel_subagent` may return. */
const CANCEL_STATUSES = ['requested', 'not-running', 'refused', 'error']

const DEFAULT_BUDGET_MS = 120000
const MIN_BUDGET_MS = 1000
const MAX_BUDGET_MS = 3600000
/** Caps `summary` so one delegation cannot flood the parent's context. */
const SUMMARY_LIMIT = 400
/**
 * Cap on one appended summary note (withSummaryNote / withDuplicateNote).
 * A note is PREPENDED (and capped on its own) before the child's own summary, so
 * the isolate/tools/duplicate notices can never be truncated away by a long
 * answer; the base text simply gets whatever room is left under SUMMARY_LIMIT.
 */
const NOTE_LIMIT = 160
/** Caps `denials` for the same reason. */
const DENIAL_LIMIT = 10

/** A fresh all-zero usage record. */
function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

/** Every count at zero, for a batch that refused everything before starting. */
function zeroCounts() {
  const counts = {}
  for (const status of STATUSES) counts[status] = 0
  return counts
}

/** Coerce a caller-supplied wait budget into the supported range. */
function clampBudget(value) {
  const budget = Number(value)
  if (!Number.isFinite(budget)) return DEFAULT_BUDGET_MS
  return Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Math.round(budget)))
}

/**
 * Coerce `timeoutAction` — what a BUDGET timeout does to the child.
 *
 * The default `detach` is the historical behavior: the child keeps running,
 * keeps its write lease, and its answer arrives later as a message. `interrupt`
 * stops it instead, so a caller that only wanted an answer does not leave a
 * writer running against the workspace.
 */
function normalizeTimeoutAction(value) {
  return value === 'interrupt' ? 'interrupt' : 'detach'
}

/**
 * Coerce `maxRuntimeMs` — the cap on a CHILD lifetime, independent of the wait
 * budget. 0 (or anything unusable) disables the cap entirely.
 */
function clampMaxRuntime(value) {
  const runtime = Number(value)
  if (!Number.isFinite(runtime) || runtime <= 0) return 0
  // No MIN floor: a window this short is a caller's deliberate choice (test,
  // or a hard stop for a writer), and 0 already means 'no cap'.
  return Math.min(MAX_BUDGET_MS, Math.max(1, Math.round(runtime)))
}

/**
 * Parse the OPTIONAL model selection of one delegation into the runtime's
 * `AgentOptions`.
 *
 * Two accepted shapes, one result:
 *   - `model: "provider/model"` — split at the FIRST `/`, so a model id that
 *     itself contains slashes (`vendor/family/model`) survives;
 *   - `provider` + `model` given separately.
 * The dotted shape wins when both are passed. This parser only rejects a
 * selection that cannot be expressed as a `provider/model` pair, so the caller
 * gets a clear message instead of a provider-side puzzle. Two decisions happen
 * AFTER it, in the delegation path: {@link checkExplicitModelSelection}
 * authorizes the choice against the official subagent model-selection switch,
 * and {@link checkModelRoute} asks the LLM catalog whether that model exists.
 *
 * Returns `{ ok, message }` on a bad selection, else
 * `{ ok: true, agentOptions, model }`, where `agentOptions` is undefined when
 * nothing was requested and `model` is the `provider/model` string to report.
 * Never throws.
 */
function parseModelChoice(spec) {
  const rawModel = typeof spec?.model === 'string' ? spec.model.trim() : ''
  const rawProvider = typeof spec?.provider === 'string' ? spec.provider.trim() : ''
  const rawEffort = typeof spec?.reasoningEffort === 'string' ? spec.reasoningEffort.trim() : ''
  let provider = ''
  let model = ''
  if (rawModel.includes('/')) {
    const cut = rawModel.indexOf('/')
    provider = rawModel.slice(0, cut).trim()
    model = rawModel.slice(cut + 1).trim()
    if (provider === '' || model === '') {
      return {
        ok: false,
        message: `model ${JSON.stringify(rawModel)} is not a usable "provider/model" pair (both halves must be non-empty)`,
      }
    }
    if (rawProvider !== '' && rawProvider !== provider) {
      log(`model: "${rawModel}" wins over provider="${rawProvider}" (dotted form takes precedence)`)
    }
  } else if (rawModel !== '') {
    if (rawProvider === '') {
      return {
        ok: false,
        message: `model ${JSON.stringify(rawModel)} is not in "provider/model" form; use model="<provider>/<model>" `
          + 'or pass `provider` and `model` separately',
      }
    }
    provider = rawProvider
    model = rawModel
  } else if (rawProvider !== '') {
    return {
      ok: false,
      message: `provider ${JSON.stringify(rawProvider)} was given without a model; use model="<provider>/<model>" `
        + 'or pass `provider` and `model` separately',
    }
  }

  const hasModel = provider !== '' && model !== ''
  if (!hasModel && rawEffort === '') return { ok: true, agentOptions: undefined, model: undefined }
  const agentOptions = hasModel ? { provider, model } : {}
  if (rawEffort !== '') agentOptions.reasoningEffort = rawEffort
  return { ok: true, agentOptions, model: hasModel ? `${provider}/${model}` : undefined }
}

/**
 * Render one LLM model exactly the way the official `list-models.ts`
 * `modelLine()` does — same fields, same punctuation, no added judgement.
 * `description` is optional and only appended when the provider supplied one.
 */
function modelLine(provider, model) {
  const suffix = typeof model?.description === 'string' && model.description !== ''
    ? `: ${model.description}`
    : ''
  return `${provider}/${String(model?.id ?? '')} — ${String(model?.name ?? model?.id ?? '')}${suffix}`
}

/** Marker for a setting wrapper whose `get()` threw: "could not be read", not a value. */
const SETTING_UNREADABLE = Symbol('setting-unreadable')

/**
 * Read a plain value or a live setting wrapper (schemastery `Volatile`).
 * A wrapper whose `get()` throws comes back as {@link SETTING_UNREADABLE}, so a
 * caller can tell "the setting says nothing" apart from "the setting could not
 * be read at all" instead of treating both as a value.
 */
function readSetting(value) {
  try {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  } catch {
    return SETTING_UNREADABLE
  }
  return value
}

/**
 * Normalize an `allowedModels` list into exact `{provider, model}` routes.
 * Returns `undefined` only for a value that is not a list at all; a list whose
 * entries are all unusable comes back as the EMPTY list, which is a decision
 * ("nothing is allowed"), not a read failure. Duplicates are dropped, matching
 * the official settings' own uniqueness rule.
 */
function normalizeRoutes(value) {
  if (!Array.isArray(value)) return undefined
  const routes = []
  for (const route of value) {
    if (typeof route?.provider !== 'string' || route.provider === '') continue
    if (typeof route?.model !== 'string' || route.model === '') continue
    if (routes.some(known => known.provider === route.provider && known.model === route.model)) continue
    routes.push({ provider: route.provider, model: route.model })
  }
  return routes
}

/**
 * What this Session's OFFICIAL subagent model-selection switch says.
 *
 * Three outcomes, never an exception:
 *   - `{ routes, source }` — the switch is ON for this Session, or the Session
 *     carries a recorded policy: only these exact `{provider, model}` routes may
 *     be selected. An empty list means none; `source` says whether that list came
 *     from the durable `policy` or from the live `switch`, because the two mean
 *     different things to a user (a policy cannot be changed by the switch).
 *   - `{ closed: true }` — the switch is readable and OFF: a delegated child may
 *     not select a route at all. This is how `delegate` FOLLOWS the official
 *     setting instead of quietly widening when it is turned off. The official
 *     tool would still accept the parent's own route; refusing even that is the
 *     one deliberate difference, and the refusal says how to inherit instead.
 *   - `{}` — nothing readable (the official settings row is not mounted, its
 *     `enabled` flag is not a readable boolean, or its allowed list threw): there
 *     is no user switch to follow, so the whitelist check is SKIPPED, never
 *     failed.
 *
 * The durable `subagent/model-selection-policy` event wins over the live
 * setting, exactly like the official projection: authorization is recorded when
 * a Session is created, so turning the switch off later does not revoke it. The
 * scan reads the WHOLE log (`snapshotEvents()`), because a forked Session
 * inherits its parent's policy prefix and the official projection folds that
 * prefix too; `ownEvents()` alone would silently drop it.
 */
function modelSelectionAuthority(ctx, session) {
  try {
    const events = typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : (typeof session?.ownEvents === 'function' ? session.ownEvents() : [])
    for (const event of events) {
      if (event?.type !== 'subagent/model-selection-policy') continue
      return { source: 'policy', routes: normalizeRoutes(event?.data?.allowedModels) ?? [] }
    }
  } catch (error) {
    log(`model whitelist: session policy read FAILED: ${error?.message}`)
  }
  try {
    const selection = ctx.get('subagentModelSelection')
    if (selection === undefined || selection === null) return {}
    const config = selection.config
    const enabled = readSetting(config?.enabled)
    if (enabled === false) return { closed: true }
    if (enabled !== true) {
      log('model whitelist: subagentModelSelection.enabled is not a readable boolean; the whitelist check is skipped')
      return {}
    }
    const configured = readSetting(config?.allowedModels)
    if (configured === SETTING_UNREADABLE) {
      log('model whitelist: subagentModelSelection.allowedModels is unreadable; the whitelist check is skipped')
      return {}
    }
    let allowed = normalizeRoutes(configured)
    if (allowed === undefined) {
      // Defensive second shape: today's official service exposes only `config`,
      // so this branch is dead against the shipped implementation, but a future
      // shape that moves the list onto the service still works instead of
      // silently allowing every route.
      const serviceShape = readSetting(selection.allowedModels)
      if (serviceShape !== SETTING_UNREADABLE) allowed = normalizeRoutes(serviceShape)
    }
    return { source: 'switch', routes: allowed ?? [] }
  } catch (error) {
    log(`model whitelist: subagentModelSelection read FAILED: ${error?.message}`)
    return {}
  }
}

/**
 * The refusal sentence for an explicitly selected child model while the
 * official switch is off. It names the switch the user actually turned off and
 * the way out that keeps working (omit every model field and inherit).
 */
const MODEL_SELECTION_CLOSED = '子代理模型选择已关闭'
  + '（DSH 设置 → 子智能体设置 →「允许 Agent 为子智能体选择模型」未开启）；'
  + '请省略 model / provider / reasoningEffort 继承本会话的模型，'
  + '或先开启该功能并配置允许的模型。'

/**
 * The refusal sentence for an explicit selection while the switch is ON but no
 * route is allowed: an empty allowlist refuses EVERY explicit field, including
 * an effort-only request, so "on but nothing allowed" can never quietly change
 * how a child runs.
 */
const MODEL_ALLOWLIST_EMPTY = '子代理模型选择已开启，但允许列表为空'
  + '（DSH 设置 → 子智能体设置 →「允许 Agent 为子智能体选择模型」）；'
  + '请先至少允许一个模型，或关闭该功能后省略 model / provider / reasoningEffort 继承本会话的模型。'

/**
 * The refusal sentence for a Session whose RECORDED policy names no usable
 * route. That policy is durable and was written by the official Host at session
 * creation, so pointing at the Settings switch would be wrong: changing it
 * cannot revive this session.
 */
const MODEL_POLICY_UNUSABLE = '本会话记录的子代理模型授权为空'
  + '（由官方在会话创建时写入，之后的设置变更不会改变它）：本会话不能显式选择子代理模型；'
  + '请省略 model / provider / reasoningEffort 继承本会话的模型，或在新会话中按当前设置执行。'

/**
 * Authorize one explicit child-model selection against the official switch.
 * @param ctx - the plugin context, read for the LLM catalog used to render choices.
 * @param session - the calling agent's Session whose recorded policy applies.
 * @param choice - what {@link parseModelChoice} returned: `agentOptions` carries
 * `provider`/`model` only when a model was chosen, so an effort-only request is
 * authorized without a route comparison.
 * @returns `{ ok: true }`, or a refusal carrying the denial code the tool result
 * reports and the sentence a caller reads.
 */
async function checkExplicitModelSelection(ctx, session, choice) {
  const authority = modelSelectionAuthority(ctx, session)
  if (authority.closed === true) {
    return { ok: false, code: 'MODEL_SELECTION_CLOSED', message: MODEL_SELECTION_CLOSED }
  }
  const routes = authority.routes
  if (routes === undefined) return { ok: true }
  if (routes.length === 0) {
    return authority.source === 'policy'
      ? { ok: false, code: 'MODEL_POLICY_UNUSABLE', message: MODEL_POLICY_UNUSABLE }
      : { ok: false, code: 'MODEL_NOT_ALLOWED', message: MODEL_ALLOWLIST_EMPTY }
  }
  const chosen = choice.agentOptions
  if (chosen?.provider === undefined || chosen.model === undefined) return { ok: true }
  // Compare the pair, never a joined `provider/model` string: the official
  // allowlist compares its two fields, and a joined comparison would let a
  // provider id that contains "/" alias another route.
  if (routes.some(route => route.provider === chosen.provider && route.model === chosen.model)) return { ok: true }
  const labels = routes.map(route => `${route.provider}/${route.model}`)
  let choices = labels.join(', ')
  try {
    const llm = ctx.get('llm')
    if (llm !== undefined && llm !== null && typeof llm.listProviders === 'function') {
      choices = await routeLines(llm, labels)
    }
  } catch (error) {
    log(`model whitelist: rendering allowed routes FAILED (kept bare routes): ${error?.message}`)
  }
  return {
    ok: false,
    code: 'MODEL_NOT_ALLOWED',
    message: `route "${chosen.provider}/${chosen.model}" 未在子代理模型白名单中；可选: ${choices}`,
  }
}

/** Advertised models per provider, briefly cached so a batch pays once. */
const MODELS_CACHE_TTL_MS = 60_000
const modelsCache = new Map()

/** `llm.listModels(provider)` with a short cache; undefined when unreadable. */
async function modelsOf(llm, provider) {
  const cached = modelsCache.get(provider)
  if (cached !== undefined && Date.now() - cached.at < MODELS_CACHE_TTL_MS) return cached.models
  const models = await llm.listModels(provider)
  if (!Array.isArray(models)) return undefined
  modelsCache.set(provider, { at: Date.now(), models })
  return models
}

/** Cap on candidate routes listed in one diagnostic, so a card stays readable. */
const MODEL_LIST_LIMIT = 12

/**
 * Render ONE exact route with the official metadata when the LLM catalog can
 * supply it (`provider/model — name[: description]`).
 *
 * A whitelist may name routes the catalog does not advertise — hand-configured,
 * or a provider that is not mounted here. Those stay the BARE `provider/model`:
 * never an error, never omitted, and never a guess about what the model is.
 */
async function routeLine(llm, provider, model) {
  const bare = `${provider}/${model}`
  try {
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return bare
    const providers = llm.listProviders()
    if (!Array.isArray(providers) || !providers.some(info => info?.id === provider)) return bare
    if (typeof llm.listModels !== 'function') return bare
    const models = await modelsOf(llm, provider)
    if (!Array.isArray(models)) return bare
    const match = models.find(info => info?.id === model)
    return match === undefined ? bare : modelLine(provider, match)
  } catch {
    return bare
  }
}

/** Render candidate routes, in order, through {@link routeLine}. */
async function routeLines(llm, routeLabels) {
  const lines = []
  for (const label of routeLabels) {
    if (lines.length >= MODEL_LIST_LIMIT) {
      lines.push('…')
      break
    }
    const cut = label.indexOf('/')
    lines.push(await routeLine(llm, label.slice(0, cut), label.slice(cut + 1)))
  }
  return lines.join(', ')
}

/** `modelLine()` for every model the given providers advertise, capped. */
async function advertisedRouteLines(llm, providerIds) {
  const lines = []
  for (const id of providerIds) {
    if (lines.length >= MODEL_LIST_LIMIT) break
    let models
    try {
      models = await modelsOf(llm, id)
    } catch {
      models = undefined
    }
    if (!Array.isArray(models)) continue
    for (const info of models) {
      if (typeof info?.id !== 'string' || info.id === '') continue
      if (lines.length >= MODEL_LIST_LIMIT) break
      lines.push(modelLine(id, info))
    }
  }
  return lines
}

/**
 * Validate one EXPLICITLY selected route the friendly way.
 *
 * A wrong name is answered with the available choices rendered from the
 * official metadata — never with a provider error, never with our own prose.
 * All diagnostic paths render candidates the same way: official
 * `id`/`name`/`description` only, i.e. `provider/model — name[: description]`
 * for a route, `id — name` for a provider, and a bare `provider/model` when the
 * catalog cannot describe that route.
 *
 * Every unreadable service (no `llm`, catalog not advertised) skips its own
 * check: validation must never make `delegate` unusable. The official
 * model-selection switch is NOT read here; {@link checkExplicitModelSelection}
 * has already authorized the choice, so this only answers "does that model
 * exist".
 */
async function checkModelRoute(ctx, routeLabel) {
  const cut = routeLabel.indexOf('/')
  const provider = routeLabel.slice(0, cut)
  const model = routeLabel.slice(cut + 1)

  // The LLM service is optional: without it every check is skipped.
  let llm
  try {
    llm = ctx.get('llm')
  } catch (error) {
    llm = undefined
  }
  if (llm !== undefined && llm !== null && typeof llm.listProviders !== 'function') llm = undefined
  if (llm === undefined || llm === null) return { ok: true }

  // 1) The provider must be registered...
  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    log(`model check: listProviders FAILED (skipped): ${error?.message}`)
    return { ok: true }
  }
  if (!Array.isArray(providers)) return { ok: true }
  const available = providers.filter(info => typeof info?.id === 'string' && info.id !== '')
  if (!available.some(info => info.id === provider)) {
    const providerText = available
      .map(info => `${info.id} — ${String(info.name ?? info.id)}`)
      .join(', ')
    const routeText = typeof llm.listModels === 'function'
      ? (await advertisedRouteLines(llm, available.map(info => info.id))).join(', ')
      : ''
    return {
      ok: false,
      message: `LLM provider "${provider}" is not registered; available providers: `
        + `${providerText === '' ? '(none)' : providerText}`
        + (routeText === '' ? '' : `; available models: ${routeText}`),
    }
  }

  // 2) ...and advertise the model. Catalog membership is advisory in DSH, so
  //    only a NON-empty catalog that omits it proves the model wrong.
  if (typeof llm.listModels !== 'function') return { ok: true }
  let models
  try {
    models = await modelsOf(llm, provider)
  } catch (error) {
    log(`model check: listModels("${provider}") FAILED (skipped): ${error?.message}`)
    return { ok: true }
  }
  if (!Array.isArray(models)) return { ok: true }
  const advertised = models.filter(info => typeof info?.id === 'string' && info.id !== '')
  if (advertised.length === 0) {
    log(`model check: provider "${provider}" advertises no models; skipping the model check`)
    return { ok: true }
  }
  if (!advertised.some(info => info.id === model)) {
    return {
      ok: false,
      message: `model "${routeLabel}" is not advertised by provider "${provider}"; available models: `
        + advertised.map(info => modelLine(provider, info)).join(', '),
    }
  }
  return { ok: true }
}

/** Detach a Cordis listener handle, whatever shape it came in. Never throws. */
function dismiss(handle) {
  try {
    if (typeof handle === 'function') handle()
    else if (typeof handle?.dispose === 'function') handle.dispose()
  } catch {
    /* a stray disposer must not break the tool call */
  }
}

/** Concatenate the text blocks of a ContentBlock[] (or a bare string). */
function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (typeof block === 'string') out += block
    else if (typeof block?.text === 'string') out += block.text
  }
  return out
}

/**
 * Strip ANSI escape sequences and the remaining C0/C1 control characters from
 * text that is about to reach a log line, a tool card, or a text table. A child
 * summary is untrusted text: ESC sequences can redraw a terminal-styled card,
 * and lone control bytes can break an aligned table. Newlines and tabs are left
 * alone here; callers collapse or preserve whitespace as they need.
 */
function stripControlChars(value) {
  return String(value ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** One line, whitespace-collapsed, control characters stripped, length-capped. */
function summarize(text) {
  const flat = stripControlChars(text).replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT - 1)}…` : flat
}

/** The empty child view, used when the log cannot be read at all. */
function emptyView() {
  return {
    denials: [],
    /**
     * How many denials the log carries, independent of the DENIAL_LIMIT cap on
     * the `denials` array itself. Round 2 of `deliberate` diffs this count, so a
     * round-1 list that already filled DENIAL_LIMIT cannot hide a new denial.
     */
    denialCount: 0,
    depthDenied: false,
    toolError: false,
    /**
     * How many failed tool results the log carries. `toolError` stays as the
     * boolean compat flag; the COUNT is what lets round 2 of `deliberate` take a
     * before/after diff, so a tool error the child recovered from in round 1 is
     * not read as a round-2 failure.
     */
    toolErrorCount: 0,
    lastTurnEnd: undefined,
    lastAssistant: '',
    usage: zeroUsage(),
    /** The route the child actually ran on (`provider/model`), when readable. */
    model: '',
    /** The provider's own message for a failed turn, when the log carries it. */
    turnError: '',
    /** Prompt size of the child's LAST assistant turn: `inputTokens +
     * cacheReadTokens`, i.e. what its next request would pay again. Kept apart
     * from `usage` (which sums every turn) because context occupancy is a
     * snapshot, not a total.
     */
    lastPromptTokens: 0,
    /**
     * The model window the child's own LAST request resolved to, from its
     * `request/context` event (`{ provider, model, contextWindow }`). 0 means
     * "unknown": the LLM catalog (`LlmModelInfo`) does NOT carry a context
     * window in this DSH, so this event is the only trustworthy denominator.
     */
    contextWindow: 0,
  }
}

/**
 * Record the model route a child actually ran on, from a provider-reported
 * event. Only a complete `provider/model` pair is kept: a partial pair leaves the
 * last known value alone rather than guessing.
 */
function rememberModel(view, provider, model) {
  if (typeof provider !== 'string' || provider === '') return
  if (typeof model !== 'string' || model === '') return
  view.model = `${provider}/${model}`
}

/**
 * Read everything the contract needs out of the CHILD's own session log.
 *
 * `ctx.get('sessions').get(childId)` is the read path (the store's `Session`
 * exposes `ownEvents()` / `snapshotEvents()`); `ctx.get('agents').get(id)?.session`
 * is the fallback, and a Session captured at activation time is the last resort
 * because a settled child may already have left the store. `tokenMeter.measure`
 * only fills in `totalTokens` when no per-message usage was logged.
 */
function inspectChild(ctx, childId, knownSession) {
  const view = emptyView()
  let session = knownSession
  try {
    if (session === undefined) {
      session = ctx.get('sessions')?.get(childId) ?? ctx.get('agents')?.get(childId)?.session
    }
  } catch (error) {
    log(`delegate: child session lookup FAILED: ${error?.message}`)
  }
  if (session === undefined) return view

  let events = []
  try {
    if (typeof session.ownEvents === 'function') events = session.ownEvents()
    else if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
  } catch (error) {
    log(`delegate: child events read FAILED: ${error?.message}`)
  }

  // `tool/result` carries only the callId; the tool name lives on `tool/call`.
  const toolNames = new Map()
  for (const event of events) {
    try {
      const type = event?.type
      const data = event?.data
      if (type === 'tool/call') {
        toolNames.set(String(data?.callId), String(data?.name ?? '?'))
      } else if (type === 'tool/result') {
        const isError = data?.message?.isError === true || data?.error !== undefined
        if (!isError) continue
        view.toolError = true
        view.toolErrorCount += 1
        // Sandbox refusals carry `code`/`name` at the top level; a tool-guard
        // refusal is materialized by the host as
        // `error: { message, info: { name, code, reason } }` (dsh-tools pipeline).
        // Read both shapes, so this plugin's own write-scope guard is attributed
        // instead of looking like an unrelated tool error.
        const failure = data?.error
        const code = String(failure?.code ?? failure?.info?.code ?? failure?.name ?? 'UNKNOWN')
        const reason = String(failure?.reason ?? failure?.info?.reason ?? '')
        const callId = String(data?.message?.toolCallId ?? '')
        const tool = toolNames.get(callId) ?? '?'
        // Classification is "the tool result is an error"; the code
        // only attributes it. Sandbox refusals and this plugin's own write-scope
        // refusals are actionable denials, so they land in `denials`.
        if (/SANDBOX_DENIED/i.test(code) || /SANDBOX_DENIED/i.test(reason) || /^WRITE_SCOPE_/i.test(code)) {
          view.denialCount += 1
          if (view.denials.length < DENIAL_LIMIT) view.denials.push({ tool, code })
        }
        // A child whose own delegation was refused for depth says so here.
        if (/DEPTH/i.test(code) || /DEPTH/i.test(reason)) view.depthDenied = true
      } else if (type === 'request/context') {
        // The route this child actually ran on, plus the ONLY trustworthy
        // denominator for context occupancy: the window the resolved request
        // used. Take the LAST such event, and only a positive finite number.
        rememberModel(view, data?.provider, data?.model)
        const contextWindow = Number(data?.contextWindow)
        if (Number.isFinite(contextWindow) && contextWindow > 0) view.contextWindow = contextWindow
      } else if (type === 'request/header') {
        const config = data?.header?.config
        rememberModel(view, config?.provider, config?.model)
      } else if (type === 'turn/end') {
        view.lastTurnEnd = String(data?.reason?.kind ?? '')
        // A turn that failed carries the provider's own `LlmFailure`
        // (`{ message, code }`). Keep it: without it a rejected model reads as a
        // bare "error" on the card with no reason anywhere.
        const failure = data?.reason?.error
        if (failure !== null && typeof failure === 'object') {
          const message = typeof failure.message === 'string' ? failure.message.trim() : ''
          const code = typeof failure.code === 'string' && failure.code !== '' ? failure.code : ''
          if (message !== '') view.turnError = code === '' ? message : `${message} (${code})`
        } else if (typeof failure === 'string' && failure.trim() !== '') {
          view.turnError = failure.trim()
        }
      } else if (type === 'assistant/message') {
        const usage = data?.usage
        if (usage !== undefined) {
          const input = Number(usage.inputTokens ?? 0)
          const output = Number(usage.outputTokens ?? 0)
          view.usage.inputTokens += Number.isFinite(input) ? input : 0
          view.usage.outputTokens += Number.isFinite(output) ? output : 0
          view.usage.totalTokens += Number(usage.totalTokens ?? ((Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)))
          // Context occupancy: the LAST assistant turn overwrites (it is a
          // snapshot, not a total). A prompt's real size is uncached input plus
          // cache reads; a usage record without `cacheReadTokens` counts it as 0.
          const cacheRead = Number(usage.cacheReadTokens ?? 0)
          const promptTokens = (Number.isFinite(input) ? input : 0) + (Number.isFinite(cacheRead) ? cacheRead : 0)
          if (Number.isFinite(promptTokens) && promptTokens >= 0) view.lastPromptTokens = promptTokens
        }
        const source = data?.message?.source
        if (source?.kind === 'model') rememberModel(view, source.provider, source.model)
        const text = textOf(data?.message?.content)
        if (text.trim() !== '') view.lastAssistant = text
      }
    } catch (error) {
      log(`delegate: child event parse FAILED: ${error?.message}`)
    }
  }

  if (view.usage.totalTokens === 0) {
    try {
      const measured = ctx.get('tokenMeter')?.measure?.(session)
      const baseline = measured?.baseline
      if (baseline?.kind === 'usage' && baseline.usage !== undefined) {
        view.usage.inputTokens = Number(baseline.usage.inputTokens ?? 0)
        view.usage.outputTokens = Number(baseline.usage.outputTokens ?? 0)
        view.usage.totalTokens = Number(baseline.usage.totalTokens ?? (view.usage.inputTokens + view.usage.outputTokens))
      } else if (typeof measured?.totalTokens === 'number') {
        view.usage.totalTokens = measured.totalTokens
      }
    } catch (error) {
      log(`delegate: tokenMeter measure FAILED: ${error?.message}`)
    }
  }
  return view
}

/**
 * Resolve once the child settles: whichever of `subagent/end`, the activation's
 * `result` promise, the caller's abort signal, or the budget deadline arrives
 * first. The deadline is an `outcome`, never a thrown error.
 *
 * `hooks.onAbort` (optional) runs ONCE when the CALLER signal fires, AFTER the
 * outcome is resolved: a local child cancel follows that signal, but an
 * external child that already started does not, so this hook is the only
 * chance to stop it explicitly. A failure there is only a log line — the abort
 * already decided what this delegation reports.
 */
function settle(ctx, started, childId, budgetMs, signal, hooks) {
  return new Promise((resolve) => {
    let done = false
    let endInfo
    let timer
    let offEnd
    let offAbort
    const finish = (outcome) => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      dismiss(offEnd)
      dismiss(offAbort)
      resolve(outcome.endInfo === undefined && endInfo !== undefined ? { ...outcome, endInfo } : outcome)
    }

    timer = setTimeout(() => finish({ via: 'timeout' }), budgetMs)

    try {
      offEnd = ctx.on('subagent/end', (info) => {
        try {
          const id = info?.id
          if (childId !== undefined && id !== undefined && String(id) !== String(childId)) return
          endInfo = info
          finish({ via: 'event', endInfo: info })
        } catch (error) {
          log(`delegate: subagent/end handler FAILED: ${error?.message}`)
        }
      })
    } catch (error) {
      log(`delegate: subagent/end listener FAILED: ${error?.message}`)
    }

    try {
      const result = started?.result
      if (result !== null && result !== undefined && typeof result.then === 'function') {
        Promise.resolve(result).then(
          value => finish({ via: 'result', result: value }),
          error => finish({ via: 'result-error', failure: error }),
        )
      }
    } catch (error) {
      log(`delegate: activation result hook FAILED: ${error?.message}`)
    }

    // One abort path for both entry points: resolve the outcome first, then let
    // the caller stop an external child that the parent signal cannot reach.
    const finishAborted = () => {
      finish({ via: 'aborted' })
      if (typeof hooks?.onAbort !== 'function') return
      try {
        hooks.onAbort()
      } catch (error) {
        log(`delegate: abort interrupt FAILED: ${error?.message}`)
      }
    }
    try {
      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        if (signal.aborted === true) {
          finishAborted()
          return
        }
        signal.addEventListener('abort', finishAborted, { once: true })
        offAbort = () => signal.removeEventListener('abort', finishAborted)
      }
    } catch (error) {
      log(`delegate: abort hook FAILED: ${error?.message}`)
    }
  })
}

/**
 * Map the child's log plus the settlement outcome onto one status.
 *
 * Order matters: a deadline outranks everything (there is no later data), then
 * a depth refusal (it explains every downstream error), then the run's own stop
 * reason, then `turn/end`. A sandbox/guard refusal inside the child is NOT a
 * status: it is recorded in `denials[]` for attribution, and the status still
 * comes from how the run ended (a recovered error does not condemn `completed`).
 */
function decideStatus(view, outcome) {
  if (outcome.via === 'timeout') return 'timeout'
  if (outcome.via === 'aborted') return 'interrupted'
  if (outcome.via === 'result-error') {
    const message = String(outcome.failure?.message ?? outcome.failure ?? '')
    return /depth/i.test(message) ? 'depth-exhausted' : 'error'
  }
  if (view.depthDenied) return 'depth-exhausted'

  // The lifecycle event is published AFTER teardown, so its stop reason is the
  // authoritative one; the activation result keeps the pre-teardown value.
  const stop = outcome.endInfo?.stopReason ?? outcome.result?.stopReason
  if (stop === 'aborted') return 'interrupted'
  if (stop === 'error' || stop === 'refusal') return 'error'
  if (stop === 'max-tokens') return 'partial'
  // An explicit "completed" outranks a tool error the child recovered from: the
  // Classification looks at the FINAL run, not its history; `toolError` below is
  // only for a run that ended without a clean turn closer.
  if (stop === 'completed') return 'ok'

  switch (view.lastTurnEnd) {
    case 'aborted':
    case 'interrupted':
      return 'interrupted'
    case 'error':
      return 'error'
    case 'max-tokens':
    case 'blocked':
      return 'partial'
    case 'completed':
      return 'ok'
    default:
      break
  }
  // No `turn/end` in the log and no explicit stop reason: the child settled
  // without a clean closer, so a failed tool call is the best evidence there is.
  if (view.toolError) return 'error'
  return view.lastAssistant === '' ? 'error' : 'ok'
}

/**
 * The one-line explanation of a row whose WAIT cap expired.
 *
 * The child is normally still running (the default action is `detach`), so the
 * text names the two ways out instead of quoting partial output: `send_message`
 * resumes it, `cancel_subagent` stops it. A writer also still owns its write
 * scope, so re-dispatching the same paths would collide with a live child.
 */
function timeoutSummary(name, kind, budgetMs) {
  const budget = Number.isFinite(Number(budgetMs)) ? `${Number(budgetMs)}ms` : 'the wait cap'
  const base = `child ${name} is still running after ${budget}`
  if (kind === 'write') {
    return `${base}; it still holds its write scope, so do NOT re-dispatch the same paths — resume it with send_message or stop it with cancel_subagent`
  }
  return `${base}; its answer will arrive as a message — resume it with send_message or stop it with cancel_subagent`
}

/**
 * Choose the one-line summary: the DEADLINE first, then the end message, then
 * the log text, then the result.
 */
function pickSummary(view, outcome, name, status, kind, budgetMs) {
  try {
    // A deadline outranks whatever partial text the child emitted: the row
    // exists to say the child is STILL RUNNING, not to quote the beginning of
    // an answer that will arrive as a message anyway.
    if (outcome?.via === 'timeout') return summarize(timeoutSummary(name, kind, budgetMs))
    const fromEnd = textOf(outcome?.endInfo?.lastAssistantMessage)
    if (fromEnd.trim() !== '') return summarize(fromEnd)
    if (view.lastAssistant.trim() !== '') return summarize(view.lastAssistant)
    const fromResult = textOf(outcome?.result?.output)
    if (fromResult.trim() !== '') return summarize(fromResult)
    if (typeof outcome?.result?.diagnostic === 'string' && outcome.result.diagnostic.trim() !== '') {
      return summarize(outcome.result.diagnostic)
    }
    if (outcome?.failure !== undefined) {
      return summarize(`child ${name} failed: ${String(outcome.failure?.message ?? outcome.failure)}`)
    }
    // A turn the provider itself ended with an error: its message is the reason,
    // and the rendered card is the only place that reason can be read.
    if (view.turnError !== '' && (status === 'error' || status === 'interrupted')) {
      return summarize(`child ${name} failed: ${view.turnError}`)
    }
    return summarize(`child ${name}: ${status}`)
  } catch {
    return summarize(`child ${name}: ${status}`)
  }
}

// ---------------------------------------------------------------------------
// Shared delegation internals
//
// `delegate` and `delegate_many` run the SAME lifecycle: preflight, privilege
// check, a serialized start (the kind slot is single-slot per parent), then a
// wait that maps the child's own log onto the result contract. Only scheduling
// differs, so both tools share these helpers instead of carrying two copies of
// the judgement logic.
// ---------------------------------------------------------------------------

/**
 * Serialize one parent's "kind slot + startActivation" window, FIFO.
 *
 * The body runs strictly after every earlier holder released, so the slot is
 * set and consumed (`agent/created`) before the next holder touches it. The
 * queue tail never rejects, so one failed start cannot wedge the queue; the map
 * entry is dropped as soon as the queue drains.
 */
function withKindSlot(parentId, body) {
  const previous = kindQueues.get(parentId) ?? Promise.resolve()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  // The tail settles only when THIS holder releases (it adopts `gate`), so the
  // next acquirer waits for it without any shared mutable counter.
  const tail = previous.then(() => gate, () => gate)
  kindQueues.set(parentId, tail)
  return previous.catch(() => {}).then(async () => {
    try {
      return await body()
    } finally {
      release()
      // Only the last holder deletes the entry; a later acquirer keeps its own.
      if (kindQueues.get(parentId) === tail) kindQueues.delete(parentId)
    }
  })
}

/** Coerce a requested kind; an unknown value means the documented default. */
function normalizeKind(value) {
  return ['read', 'write', 'verify'].includes(value) ? value : 'read'
}

/**
 * The kind the CALLER was granted, for the monotonic privilege check.
 *
 * **A missing record must be fail-closed.** `kindOfSession` is filled by the
 * `agent/created` hook, which can legitimately be unable to say anything about a
 * caller: the trimming gate was off (the switch off, `matriline.paused`) or a
 * plugin reload cleared the map. An absent entry therefore says NOTHING about the
 * caller's privilege, and assuming `write` was a privilege-escalation hole: a
 * read-only reader could ask for a `write` grandchild and get it.
 *
 * The default is decided by the caller's own IDENTITY instead:
 *   - a CHILD session (`origin === 'subagent'`, or any `parentSession`) with no
 *     record ⇒ `read`, the lowest rank (fail-closed);
 *   - a ROOT session ⇒ `write`, because a root session is the human's own session
 *     and its kind was never granted by this plugin;
 *   - a caller with no readable header at all ⇒ `read` as well (still
 *     fail-closed: an unknown caller gets the lowest privilege).
 */
function callerKindOf(parent, parentId) {
  const id = parentId ?? sessionIdOf(parent)
  let recorded
  try {
    recorded = id === undefined ? undefined : kindOfSession.get(String(id))
  } catch {
    recorded = undefined
  }
  if (recorded !== undefined) return recorded
  let header
  try {
    header = sessionHeaderOf(parent)
  } catch {
    header = undefined
  }
  if (header !== undefined) {
    const isChild = header.origin === 'subagent' || header.parentSession !== undefined
    if (isChild) {
      // FAIL-CLOSED: no record for a child means "lowest privilege", never "write".
      log(`privilege: no kind recorded for child session=${String(id)} (gate was off or the plugin reloaded) — failing closed to kind="read"`)
      return 'read'
    }
    return 'write'
  }
  log(`privilege: no session header for caller=${String(id)} — failing closed to kind="read"`)
  return 'read'
}

/**
 * The kind recorded in ONE session's OWN log, or undefined.
 *
 * The durable half of the resume fix: `kindOfSession` dies with the process, so a
 * child resumed after a plugin reload reads its granted kind back from the
 * `plugin:matriline/kind` record that its FIRST creation appended. The LAST such
 * record wins; an unrecognized payload is
 * ignored rather than trusted. Never throws — the caller is a serial
 * `agent/created` listener, where a throw would reject the child creation.
 */
function kindFromSessionLog(ctx, sessionId, knownSession) {
  const candidates = []
  const add = (session) => {
    try {
      if (session === undefined || session === null) return
      if (candidates.includes(session)) return
      candidates.push(session)
    } catch {
      /* an exotic session object is skipped, not fatal */
    }
  }
  add(knownSession)
  // The store is the documented read path (`deliberate` / `runs` use it), and a
  // resumed Session may sit behind a different instance than the agent's own.
  try {
    add(ctx?.get?.('sessions')?.get?.(sessionId))
  } catch {
    /* no store: the captured session is all we have */
  }
  try {
    add(ctx?.get?.('agents')?.get?.(sessionId)?.session)
  } catch {
    /* no agent registry: ditto */
  }
  for (const session of candidates) {
    try {
      const events = typeof session.ownEvents === 'function'
        ? session.ownEvents()
        : typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      let recorded
      for (const event of events) {
        if (event?.type !== KIND_EVENT_TYPE) continue
        const kind = event?.data?.kind
        if (Object.hasOwn(KIND_RANK, kind)) recorded = kind
      }
      if (recorded !== undefined) return recorded
    } catch (error) {
      log(`kind: record read FAILED for session=${String(sessionId)}: ${error?.message}`)
    }
  }
  return undefined
}

/**
 * Persist a child's granted kind into its OWN log, at most once. Never rejects.
 *
 * Idempotence is checked BEFORE writing: a session that already carries a
 * `plugin:matriline/kind` record is left untouched, so a re-created session can
 * never grow a second record. The writer is the optional
 * `appendPluginRecord` (resolved once, below); when it is
 * unavailable, or throws, or hands back a different Session class, this only
 * logs — the child creation must go on.
 */
async function recordKindOnce(ctx, session, kind, sessionId) {
  try {
    if (session === undefined || !Object.hasOwn(KIND_RANK, kind)) return false
    if (kindFromSessionLog(ctx, sessionId, session) !== undefined) {
      log(`kind: record already present for session=${String(sessionId)} — not appended again`)
      return false
    }
    const api = await pluginRecordApi()
    if (api === undefined) {
      log(`kind: appendPluginRecord unavailable; kind=${kind} for session=${String(sessionId)} not persisted`)
      return false
    }
    if (typeof api.SessionClass === 'function' && !(session instanceof api.SessionClass)) {
      log('kind: session module instance differs; refusing appendPluginRecord')
      return false
    }
    api.append(session, KIND_EVENT_TYPE, { kind })
    log(`kind: recorded ${kind} on session=${String(sessionId)}`)
    return true
  } catch (error) {
    log(`kind: appendPluginRecord FAILED (creation unaffected): ${error?.message}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Durable tools profile (the resume half of the `tools` fix)
//
// `pendingTools` is a per-dispatch slot deleted in `startChild`'s `finally`, so
// nothing survives to a `send_message` resume. The profile is therefore kept in
// two places, read in this order: `pendingTools` (a new dispatch) →
// `toolsOfSession` (this process) → the child's own `plugin:matriline/tools`
// record (survives a reload). The last tier is what makes the fix real; a
// `full` writer must come back with `full`, not with the 13-tool writer set.
// ---------------------------------------------------------------------------

/**
 * Every session object that may carry `sessionId`'s own events, de-duplicated.
 *
 * Same read paths as {@link kindFromSessionLog}, but kept local so the `kind`
 * logic is untouched. A candidate this process cannot reach is skipped, never
 * fatal: the caller is a serial `agent/created` listener where a throw rejects
 * the child creation.
 */
function sessionCandidatesFor(ctx, sessionId, knownSession) {
  const candidates = []
  const add = (session) => {
    try {
      if (session === undefined || session === null) return
      if (candidates.includes(session)) return
      candidates.push(session)
    } catch {
      /* an exotic session object is skipped, not fatal */
    }
  }
  add(knownSession)
  // The store is the documented read path, and a resumed Session may sit behind
  // a different instance than the agent's own.
  try {
    add(ctx?.get?.('sessions')?.get?.(sessionId))
  } catch {
    /* no store: the captured session is all we have */
  }
  try {
    add(ctx?.get?.('agents')?.get?.(sessionId)?.session)
  } catch {
    /* no agent registry: ditto */
  }
  return candidates
}

/**
 * One recorded payload → a resolved profile (`{ mode: 'minimal' | 'full' |
 * 'list' }`), or undefined when the payload is not a tools record this plugin
 * wrote. `names` is the durable spelling of a name array (see
 * {@link toolsRecordOf}); an unusable list degrades to `minimal` exactly like
 * {@link resolveToolsProfile} does, instead of being trusted as an empty allow list.
 */
function toolsProfileFromRecord(data) {
  try {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
    if (data.mode === 'full') return { mode: 'full' }
    if (data.mode === 'minimal') return { mode: 'minimal' }
    if (data.mode === 'names' && Array.isArray(data.names)) {
      const names = data.names
        .filter(name => typeof name === 'string')
        .map(name => name.trim())
        .filter(name => name !== '')
      return names.length > 0 ? { mode: 'list', names } : { mode: 'minimal' }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** A resolved profile → the one shape the session log carries. Never throws. */
function toolsRecordOf(profile) {
  try {
    if (profile?.mode === 'full') return { mode: 'full' }
    if (profile?.mode === 'list' && Array.isArray(profile.names)) {
      return {
        mode: 'names',
        names: profile.names.filter(name => typeof name === 'string' && name !== ''),
      }
    }
    return { mode: 'minimal' }
  } catch {
    return { mode: 'minimal' }
  }
}

/** Human-readable profile for one log line (`full` / `minimal` / `names: [...]`). */
function describeToolsProfile(profile) {
  try {
    if (profile?.mode === 'full') return 'full'
    if (profile?.mode === 'list' && Array.isArray(profile.names)) {
      return `names: [${profile.names.join(', ')}]`
    }
    return 'minimal'
  } catch {
    return 'minimal'
  }
}

/** A value from {@link toolsOfSession}, accepted only when it is a profile. */
function asResolvedToolsProfile(value) {
  try {
    if (value === null || typeof value !== 'object') return undefined
    if (value.mode === 'full' || value.mode === 'minimal') return value
    if (value.mode === 'list' && Array.isArray(value.names) && value.names.length > 0) return value
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The tools profile recorded in ONE session's OWN log, or undefined.
 *
 * Durable tier of the resume fix: the LAST {@link TOOLS_EVENT_TYPE} record wins
 * (same fold rule as above), and an unrecognized payload is ignored rather
 * than trusted. Every read is guarded — the caller is the serial `agent/created`
 * listener, where a throw would reject the child creation.
 */
function toolsProfileFromSessionLog(ctx, sessionId, knownSession) {
  for (const session of sessionCandidatesFor(ctx, sessionId, knownSession)) {
    try {
      const events = typeof session.ownEvents === 'function'
        ? session.ownEvents()
        : typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      let recorded
      for (const event of events) {
        if (event?.type !== TOOLS_EVENT_TYPE) continue
        const profile = toolsProfileFromRecord(event?.data)
        if (profile !== undefined) recorded = profile
      }
      if (recorded !== undefined) return recorded
    } catch (error) {
      log(`tools: record read FAILED for session=${String(sessionId)}: ${error?.message}`)
    }
  }
  return undefined
}

/**
 * Persist a child's tools profile into its OWN log, at most once. Never rejects.
 *
 * Idempotent like {@link recordKindOnce}: an existing record is detected BEFORE
 * writing, so a resume or a re-created session never grows a second one. An
 * unavailable writer, a different Session class instance, or a throwing append
 * only logs — the child creation must go on.
 */
async function recordToolsOnce(ctx, session, profile, sessionId) {
  try {
    if (session === undefined) return false
    const record = toolsRecordOf(profile)
    if (toolsProfileFromSessionLog(ctx, sessionId, session) !== undefined) {
      log(`tools: record already present for session=${String(sessionId)} — not appended again`)
      return false
    }
    const api = await pluginRecordApi()
    if (api === undefined) {
      log(`tools: appendPluginRecord unavailable; ${describeToolsProfile(profile)} for session=${String(sessionId)} not persisted`)
      return false
    }
    if (typeof api.SessionClass === 'function' && !(session instanceof api.SessionClass)) {
      log('tools: session module instance differs; refusing appendPluginRecord')
      return false
    }
    api.append(session, TOOLS_EVENT_TYPE, record)
    log(`tools: recorded ${describeToolsProfile(profile)} on session=${String(sessionId)}`)
    return true
  } catch (error) {
    log(`tools: appendPluginRecord FAILED (creation unaffected): ${error?.message}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Durable `skills` decision (the resume half of the skill-strip fix)
//
// Read in three tiers, in exactly the order used for `kind`/`tools`:
// `pendingSkills` (a new dispatch) → `skillsOfSession` (this process) → the
// child's own `plugin:matriline/skills` record (survives a reload) → default
// `false`. The durable tier is what keeps `skills` from drifting across a
// `send_message` resume; it is written ONCE, on the first decision, for BOTH
// values — "decided to strip" is as much a decision as "decided to keep".
// ---------------------------------------------------------------------------

/**
 * One recorded payload → the persisted `skills` boolean, or undefined when the
 * payload is not a skills record this plugin wrote. Only a real boolean is
 * trusted; anything else is ignored rather than coerced.
 */
function skillsFromRecord(data) {
  try {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
    return typeof data.skills === 'boolean' ? data.skills : undefined
  } catch {
    return undefined
  }
}

/**
 * The `skills` value recorded in ONE session's OWN log, or undefined.
 *
 * Same read paths and fold rule as {@link toolsProfileFromSessionLog}: the LAST
 * {@link SKILLS_EVENT_TYPE} record wins, an unrecognized payload is ignored, and
 * every read is guarded — the caller is the serial `agent/created` listener,
 * where a throw would reject the child creation.
 */
function skillsFromSessionLog(ctx, sessionId, knownSession) {
  for (const session of sessionCandidatesFor(ctx, sessionId, knownSession)) {
    try {
      const events = typeof session.ownEvents === 'function'
        ? session.ownEvents()
        : typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      let recorded
      for (const event of events) {
        if (event?.type !== SKILLS_EVENT_TYPE) continue
        const value = skillsFromRecord(event?.data)
        if (value !== undefined) recorded = value
      }
      if (recorded !== undefined) return recorded
    } catch (error) {
      log(`skills: record read FAILED for session=${String(sessionId)}: ${error?.message}`)
    }
  }
  return undefined
}

/**
 * Persist a child's `skills` decision into its OWN log, at most once. Never rejects.
 *
 * Idempotent like {@link recordKindOnce} / {@link recordToolsOnce}: an existing
 * record is detected BEFORE writing, so a resume (or a re-created session) never
 * grows a second one. An unavailable writer, a different Session class instance,
 * or a throwing append only logs — the child creation must go on.
 */
async function recordSkillsOnce(ctx, session, skills, sessionId) {
  try {
    if (session === undefined) return false
    const value = skills === true
    if (skillsFromSessionLog(ctx, sessionId, session) !== undefined) {
      log(`skills: record already present for session=${String(sessionId)} — not appended again`)
      return false
    }
    const api = await pluginRecordApi()
    if (api === undefined) {
      log(`skills: appendPluginRecord unavailable; skills=${String(value)} for session=${String(sessionId)} not persisted`)
      return false
    }
    if (typeof api.SessionClass === 'function' && !(session instanceof api.SessionClass)) {
      log('skills: session module instance differs; refusing appendPluginRecord')
      return false
    }
    api.append(session, SKILLS_EVENT_TYPE, { skills: value })
    log(`skills: recorded ${String(value)} on session=${String(sessionId)}`)
    return true
  } catch (error) {
    log(`skills: appendPluginRecord FAILED (creation unaffected): ${error?.message}`)
    return false
  }
}

/**
 * Monotonic privilege: a child may not delegate above the kind it was given,
 * otherwise a read-only reader could launder a write through a grandchild.
 *
 * `parent` is optional only for backwards-compatible call sites; without it the
 * identity of the caller cannot be read, so the check falls back to the
 * fail-closed default in {@link callerKindOf}.
 */
function privilegeCheck(parentId, kind, parent) {
  const callerKind = callerKindOf(parent, parentId)
  const callerRank = KIND_RANK[callerKind] ?? 0
  const requestedRank = KIND_RANK[kind] ?? 0
  if (requestedRank > callerRank) {
    return {
      allowed: false,
      callerKind,
      message: `delegate refused: this child runs as kind="${callerKind}" and may not request kind="${kind}" (privilege escalation); ask for "read"/"verify", or have the root session start the write delegation itself`,
    }
  }
  return { allowed: true, callerKind }
}

// ---------------------------------------------------------------------------
// Write-scope leases (mutual exclusion between delegated writers)
//
// Tier 1 (admission, in `startChild`): a `kind="write"` delegation leases the
// paths it may write. A second write delegation whose effective scope overlaps
// a RUNNING lease is refused with status="denied" and code
// WRITE_SCOPE_OVERLAP. A write child that declares no `scope` leases the WHOLE
// workspace root, so the default is "one writer at a time"; parallel writers
// must declare disjoint scopes.
//
// Tier 2 (enforcement, `guardWriteScope`): a global tool guard turns any
// `write` / `edit` / `apply_patch` call that lands inside ANOTHER child's lease
// into code WRITE_SCOPE_VIOLATION, so the model is told which child owns the
// file instead of silently clobbering a concurrent edit.
//
// Tier 3 (physical isolation, `beginWorktree` + `applyWorktreeToLease`): neither
// tier can stop a `bash`/`pwsh` command from writing a file. With `isolate:true`
// a write child gets its OWN git worktree and the runtime switches that child's
// session cwd into it, so two isolated writers never share a single file even
// through a shell. Such a writer SKIPS the Tier 1 overlap check (there is
// nothing to collide with) but still holds a lease scoped to its worktree, so
// the Tier 2 guard keeps protecting it — and it cannot deny anybody else's files.
//
// The map is keyed by child session id; a provisional `pending:<token>` key
// covers the window before startActivation reports the id. Releases come from
// `subagent/end`, the start-failure path, settlement liveness, a liveness sweep,
// and a hard TTL. A lease must never outlive its child and block every later
// delegation forever.
// ---------------------------------------------------------------------------

/** The only tool names the guard inspects; anything else passes untouched. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch'])

/** `childSessionId -> { parentId, childId, label, paths, at }`. See above. */
const writeLeases = new Map()

/**
 * `childSessionId -> { reason }` for a writer whose lease could NOT be restored.
 *
 * A resumed writer that this plugin dispatched runs as kind="write" but comes back
 * through `send_message` with no dispatch slot, so its lease is rebuilt from its
 * own `plugin:matriline/lease` record. When that record is missing or unusable
 * there is nothing to rebuild: this map is how the Tier 2 guard learns it must
 * REFUSE instead of passing the caller through (the old `own === undefined`
 * early-return made "no lease" indistinguishable from "the root session").
 * Only ever filled for a child that HAS a durable kind record (i.e. this plugin
 * managed it) — the root and read/verify children are never marked. Cleared on
 * `subagent/end`.
 */
const unleasedWriters = new Map()

/** Absolute backstop for a lease that missed every release path: 6 hours. */
const LEASE_TTL_MS = 6 * 60 * 60 * 1000

let leaseSeq = 0

/** A fresh provisional-lease key suffix. */
function newLeaseToken() {
  leaseSeq += 1
  return `lease-${Date.now().toString(36)}-${leaseSeq}`
}

/** The session header of a calling agent, when the runtime exposes it. */
function sessionHeaderOf(agent) {
  try {
    const header = agent?.session?.header
    if (header !== undefined) return header
  } catch {
    /* an agent stub without a session is not an error */
  }
  return undefined
}

/** The session id of a calling agent (`agent.id` is the fallback contract). */
function sessionIdOf(agent) {
  try {
    const id = agent?.session?.header?.id
    if (id !== undefined && id !== null) return String(id)
  } catch {
    /* fall through to the documented Agent.id */
  }
  try {
    if (agent?.id !== undefined && agent?.id !== null) return String(agent.id)
  } catch {
    /* no usable identity */
  }
  return undefined
}

/**
 * One forward-slash, dot-segment-free key for a path.
 *
 * Windows drive letters and case are folded because the same file is written as
 * `C:\Work\x`, `c:/work/x` and `C:/Work/./x` depending on who asks. Folding is
 * WINDOWS-ONLY (see `windowsStyle` below): a POSIX key keeps its case, because
 * `/work/A` and `/work/a` are two different files there.
 *
 * Three Windows aliasing rules are applied too, because each of them names the
 * SAME file while comparing unequal as a string — a write-scope guard that missed
 * them could be walked around with a differently spelled path:
 *   - the device prefixes `\\?\` and `\\.\` (plus `\\?\UNC\server\share`) are
 *     stripped: they are a Win32 API spelling, not a different file;
 *   - trailing dots and spaces are removed from every segment
 *     (`C:\Work\x.` / `C:\Work\x ` are `C:\Work\x`);
 *   - `.` and `..` segments are resolved lexically.
 *
 * KNOWN LIMITATION: Windows 8.3 short names (`PROGRA~1` for `Program Files`) are
 * a filesystem alias that cannot be expanded in pure JS, so `PROGRA~1` and the
 * long name still compare UNEQUAL here. {@link realPathKey} resolves existing
 * prefixes through `realpath`, which does expand a short name on the part that
 * already exists — a short name for a path that does not exist yet stays a hole.
 */
function collapsePath(input) {
  const raw = String(input)
  let text = raw.replace(/\\/g, '/')
  // `//?/C:/x` / `//./C:/x` (from `\\?\` and `\\.\`) and `//?/UNC/server/share`.
  if (text.startsWith('//?/UNC/')) text = `//${text.slice('//?/UNC/'.length)}`
  else if (text.startsWith('//?/') || text.startsWith('//./')) text = text.slice(4)
  let prefix = ''
  let absolute = false
  const drive = /^[A-Za-z]:/.exec(text)
  if (drive !== null) {
    prefix = drive[0]
    text = text.slice(prefix.length)
  } else if (text.startsWith('//')) {
    prefix = '//'
    text = text.slice(2)
  }
  // Case folding and the trailing dot/space trim are WINDOWS rules. Applying them
  // to a POSIX path is a correctness bug in both directions: `/home/Alice` collapsed
  // onto `/home/alice` (two different directories compared EQUAL, so an unrelated
  // writer was denied), and `/tmp/log.` collapsed onto `/tmp/log` (a different file).
  // Windows-shaped means a drive prefix, a UNC share, or a backslash spelling;
  // everything else keeps its exact case and trailing dots.
  const windowsStyle = drive !== null || prefix === '//' || raw.includes('\\')
  if (text.startsWith('/')) absolute = true
  const parts = []
  for (const rawPart of text.split('/')) {
    // Windows ignores trailing dots and spaces in a path segment.
    let part = windowsStyle ? rawPart.replace(/[. ]+$/, '') : rawPart
    if (part === '') part = rawPart
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(part)
  }
  let joined = parts.join('/')
  if (prefix !== '') joined = `${prefix}/${joined}`
  else if (absolute) joined = `/${joined}`
  // A drive ROOT keeps its slash: `c:` is DRIVE-RELATIVE (`C:\x` is not `C:/x`),
  // so it must not share the key of the root `c:/`. The old code stripped the
  // slash of every result, which is why `realpath('C:')` could alias a path onto
  // whatever directory the process happened to sit in on that drive.
  if (joined.length > 1 && joined.endsWith('/') && !/^[A-Za-z]:\/$/.test(joined)) joined = joined.slice(0, -1)
  return windowsStyle ? joined.toLowerCase() : joined
}

/**
 * Re-key ONE collapsed path through `realpath` for its longest EXISTING prefix.
 *
 * The lexical collapse above cannot see a junction / symbolic link / 8.3 short
 * name, so two different keys could name the same file (or one directory could
 * be reached through two paths, letting a writer escape a lease). Resolving the
 * part of the path that exists and re-appending the rest makes both sides agree.
 *
 * Returns undefined when nothing could be resolved (a different volume, an
 * unreadable path): the caller then keeps the lexical key and logs it, because a
 * failed `realpath` must never silently widen or disable the guard.
 *
 * KNOWN LIMITATION: the segments that do NOT exist yet are compared lexically, so
 * an 8.3 short name pointing at a not-yet-created path is still a hole.
 */
function realPathKey(value) {
  try {
    let probe = String(value)
    let tail = ''
    for (let depth = 0; depth < 12; depth += 1) {
      if (probe === '') break
      // `C:` alone is DRIVE-RELATIVE, not the drive root: `realpath('C:')` answers
      // the process's current directory on that drive (`C:\Work\project`),
      // which would re-key a whole-workspace scope onto a completely different
      // tree. Only `C:/` is the root, so probe that instead.
      if (/^[a-z]:$/i.test(probe)) probe = `${probe}/`
      try {
        const real = realpathSync(probe)
        if (typeof real === 'string' && real !== '') {
          const rekeyed = tail === '' ? real : `${real}/${tail}`
          const collapsed = collapsePath(rekeyed)
          if (collapsed !== '') return collapsed
        }
        return undefined
      } catch {
        const slash = probe.lastIndexOf('/')
        if (slash <= 0) break
        const segment = probe.slice(slash + 1)
        tail = tail === '' ? segment : `${segment}/${tail}`
        probe = probe.slice(0, slash)
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Bound on how many distinct paths may be reported as "realpath unavailable",
 * so a hot write loop cannot flood the log (see {@link realPathWarning}).
 */
const REALPATH_WARNED = new Set()
const REALPATH_WARN_LIMIT = 50

/** Log a failed `realpath` once per path (bounded), never throws. */
function realPathWarning(value, raw) {
  try {
    if (REALPATH_WARNED.size >= REALPATH_WARN_LIMIT) return
    const key = String(value)
    if (REALPATH_WARNED.has(key)) return
    REALPATH_WARNED.add(key)
    log(`path: realpath unavailable for ${key} (declared ${JSON.stringify(String(raw))}); comparing LEXICALLY`)
  } catch {
    /* the warning itself must never break a tool call */
  }
}

/**
 * One declared path → `{ value, dir, raw }`, or undefined when unparseable.
 *
 * `dir` marks "this path and everything below it" (a trailing `/**`, `/*`, or
 * `/`); a bare path matches exactly. Relative paths resolve against `base`, the
 * caller's workspace root.
 *
 * `value` is the LEXICAL key ({@link collapsePath}) re-keyed through the longest
 * existing prefix with `realpath` ({@link realPathKey}), so a junction, symbolic
 * link or an aliased spelling of the same directory lands on the same key. A
 * failed `realpath` keeps the lexical key and logs one warning per path.
 */
function normalizeScopePath(raw, base) {
  try {
    if (typeof raw !== 'string') return undefined
    let text = raw.trim()
    if (text === '') return undefined
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim()
    }
    if (text === '') return undefined
    let dir = false
    if (/[\\/]\*\*$/.test(text)) {
      dir = true
      text = text.slice(0, -3)
    } else if (/[\\/]\*$/.test(text)) {
      dir = true
      text = text.slice(0, -2)
    } else if (/[\\/]+$/.test(text)) {
      dir = true
      text = text.replace(/[\\/]+$/, '')
    }
    text = text.replace(/\\/g, '/')
    if (text === '') return undefined
    const absolute = /^[A-Za-z]:\//.test(text) || text.startsWith('/')
    if (!absolute) {
      // The base may arrive as the raw session cwd (`C:\Work\x`) or already
      // normalized (`c:/work/x`); collapse it either way before joining.
      let parent = typeof base === 'string' ? base.replace(/\\/g, '/') : ''
      if (parent === '') return undefined
      parent = collapsePath(parent)
      if (parent === '') return undefined
      text = `${parent}/${text}`
    }
    const lexical = collapsePath(text)
    if (lexical === '') return undefined
    // `text`, NOT `lexical`: realpath must see the caller's original spelling. On a
    // case-sensitive filesystem the collapsed key (`/home/alice`) does not resolve
    // at all (`/home/Alice` does), so every scope silently fell back to a lexical
    // key and two aliases of one directory could stop agreeing.
    const real = realPathKey(text)
    const value = real === undefined ? lexical : real
    if (real === undefined) realPathWarning(lexical, raw)
    return { value, dir, raw: raw.trim() }
  } catch {
    return undefined
  }
}

/** The whole workspace root of the calling agent, as a subtree scope. */
function workspaceScope(agent) {
  let cwd
  try {
    cwd = sessionHeaderOf(agent)?.cwd
  } catch {
    cwd = undefined
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    try {
      // A silent fallback leases the PROCESS directory, which is not necessarily the
      // tree the caller is looking at (a per-child session cwd is the normal case),
      // so a widened default must be observable in the log.
      cwd = process.cwd()
      log(`write scope: no session cwd for this delegation; falling back to process.cwd() = ${cwd}`)
    } catch {
      cwd = undefined
    }
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  const parsed = normalizeScopePath(cwd, undefined)
  if (parsed === undefined) return undefined
  return { value: parsed.value, dir: true, raw: cwd.trim() }
}

/** Render one scope the way a human declared it (for messages and logs). */
function scopeLabel(scope) {
  try {
    const raw = typeof scope?.raw === 'string' && scope.raw !== '' ? scope.raw : String(scope?.value ?? '?')
    if (scope?.dir === true && !/[\\/]\*\*$/.test(raw)) return `${raw}/**`
    return raw
  } catch {
    return '?'
  }
}

/** Whether a normalized path is the scope itself or (for a dir scope) below it. */
function scopeCovers(path, scope) {
  try {
    if (typeof path !== 'string' || scope === undefined) return false
    if (path === scope.value) return true
    return scope.dir === true && path.startsWith(`${scope.value}/`)
  } catch {
    return false
  }
}

/**
 * Scopes a delegated writer must never be able to write: the plugin's data dir
 * (control flags, every session's switches) and its package directory (this
 * module). Root and read-only callers never reach the guard with a lease, so
 * they are unaffected.
 */
function pluginProtectedScopes() {
  const scopes = []
  const candidates = []
  try {
    candidates.push(ROOT)
  } catch {
    /* no data dir to protect */
  }
  try {
    candidates.push(PLUGIN_DIR)
  } catch {
    /* not a file module: the package dir is unknown */
  }
  for (const candidate of candidates) {
    const parsed = normalizeScopePath(candidate, undefined)
    if (parsed !== undefined) scopes.push({ value: parsed.value, dir: true, raw: candidate })
  }
  return scopes
}

/**
 * Whether two normalized scopes overlap: either one covers the other's start.
 *
 * This is the same relation `findWriteScopeConflicts` uses against a running
 * lease, so the batch-internal pairwise test and the external test can never
 * disagree about what "overlap" means.
 */
function scopesOverlap(a, b) {
  try {
    return scopeCovers(a?.value, b) || scopeCovers(b?.value, a)
  } catch {
    return false
  }
}

/**
 * Whether a scope entry uses a WILDCARD this plugin does not implement.
 *
 * Exactly three forms are documented: a bare path (that file), `path/**`, `path/*`
 * and a trailing `/` (that subtree). Any OTHER `*` or `?` used to be folded into a
 * LITERAL path key that kept the star — `src/*.js` became the key `.../src/*.js`,
 * which covers nothing on disk. The lease then excluded nobody while the caller
 * believed its files were protected: a fail-OPEN typo in a security feature.
 * Refusing is the only honest answer, and it must not degrade to "lease the whole
 * workspace" (that would block every other writer for a typo).
 */
function unsupportedScopeGlob(raw) {
  try {
    if (typeof raw !== 'string') return false
    let text = raw.trim()
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim()
    }
    // A trailing slash is itself a documented subtree marker, so ignore it while
    // looking at the LAST segment.
    const trimmed = text.replace(/[\\/]+$/, '')
    if (!/[*?]/.test(trimmed)) return false
    return !/[\\/](?:\*\*|\*)$/.test(trimmed)
  } catch {
    return false
  }
}

/**
 * The effective scope of one delegation: `{ ok: true, scopes }` or a typed
 * refusal `{ ok: false, code: 'WRITE_SCOPE_INVALID', message }`.
 *
 * Rules, in this order:
 *   0. an entry with an UNSUPPORTED wildcard (see {@link unsupportedScopeGlob}) ⇒
 *      the task is refused with WRITE_SCOPE_INVALID. It is NOT counted as
 *      "unparsable": that path widens to the whole workspace, which would punish
 *      every other writer for one typo and still leave the caller's real files
 *      unprotected;
 *   1. no `scope` at all ⇒ the whole workspace root (documented default: one
 *      writer at a time);
 *   2. a `scope` whose entries are ALL unusable ⇒ ALSO the whole workspace root,
 *      so a typo can never silently disable mutual exclusion — but the fallback
 *      is logged as `scope unparsable, leasing whole workspace`, because widening
 *      to the root blocks every other writer and must not be silent;
 *   3. an entry that RESOLVES but lands OUTSIDE the workspace root ⇒ the task is
 *      refused with code WRITE_SCOPE_INVALID. It used to be folded into "lease
 *      the whole workspace", which let a caller pass `"../.."` and either claim
 *      the entire tree above the workspace or wedge every later write dispatch.
 *      Widening a refusal into a bigger claim is the opposite of fail-closed.
 */
function resolveWriteScopes(rawScope, base) {
  const entries = Array.isArray(rawScope) ? rawScope : (typeof rawScope === 'string' ? [rawScope] : [])
  const wildcards = entries.filter(entry => unsupportedScopeGlob(entry))
  if (wildcards.length > 0) {
    const labels = wildcards.slice(0, 3).map(entry => JSON.stringify(String(entry))).join(', ')
    const message = `write scope refused: ${labels} ${wildcards.length === 1 ? 'uses' : 'use'} a wildcard this plugin `
      + 'does not implement. Only three subtree forms exist: "path/**", "path/*" and a trailing "path/"; '
      + 'everything else is a plain file or directory path. A "*.js"-style pattern would lease nothing at all.'
    log(`write scope REFUSED (WRITE_SCOPE_INVALID): unsupported wildcard: ${labels}`)
    return { ok: false, code: 'WRITE_SCOPE_INVALID', message }
  }
  const scopes = []
  let invalid = 0
  const outside = []
  for (const entry of entries) {
    const scope = normalizeScopePath(entry, base.value)
    if (scope === undefined) {
      invalid += 1
      continue
    }
    // Inside the workspace root: the root itself, or anything below it.
    if (!scopeCovers(scope.value, { value: base.value, dir: true })) {
      outside.push(scope)
      continue
    }
    if (!scopes.some(existing => existing.value === scope.value && existing.dir === scope.dir)) {
      scopes.push(scope)
    }
  }
  if (outside.length > 0) {
    const labels = outside.map(scopeLabel).slice(0, 3).join(', ')
    const message = `write scope refused: ${labels} ${outside.length === 1 ? 'is' : 'are'} outside this task's `
      + `workspace root ${scopeLabel({ value: base.value, dir: true, raw: base.raw })}, and a scope may not widen `
      + 'beyond the workspace (a relative "../.." would claim the whole tree above it). '
      + 'Declare paths inside the workspace, or use absolute paths that stay under it.'
    log(`write scope REFUSED (WRITE_SCOPE_INVALID): outside the workspace root: ${labels}`)
    return { ok: false, code: 'WRITE_SCOPE_INVALID', message }
  }
  if (scopes.length === 0) {
    if (entries.length > 0) {
      log(`scope unparsable, leasing whole workspace (${invalid} unusable entry/entries) — mutual exclusion stays on`)
    }
    return { ok: true, scopes: [{ value: base.value, dir: true, raw: base.raw }], widened: entries.length > 0 }
  }
  return { ok: true, scopes }
}

/**
 * Every lease overlapping at least one of `scopes` — BOUND and PENDING alike.
 *
 * `delegate_many` registers every batch lease before its FIRST child starts, so a
 * queued task exists as a `pending:` lease for the whole time it waits. Skipping
 * those (the old `lease.childId === undefined` guard) made the queue invisible to
 * every OTHER parent: parent B could be admitted into the files a queued task of
 * parent A was about to write, and the collision only surfaced when the child
 * actually started. `skipKeys` excludes keys the caller already owns (a re-entrant
 * admission must not deny itself).
 *
 * The Tier 2 guard keeps its own rule (only BOUND leases are enforced there): a
 * provisional lease has no child to deny yet, and treating it as an owner would
 * make a child deny itself during the reserve→promote window.
 */
function findWriteScopeConflicts(scopes, skipKeys) {
  const skip = skipKeys instanceof Set
    ? skipKeys
    : new Set(Array.isArray(skipKeys) ? skipKeys.map(key => String(key)) : [])
  const conflicts = []
  for (const [key, lease] of writeLeases) {
    try {
      if (skip.has(String(key))) continue
      for (const mine of scopes) {
        for (const owned of lease.paths) {
          if (scopeCovers(mine.value, owned) || scopeCovers(owned.value, mine)) {
            conflicts.push({
              key,
              childId: lease.childId,
              pending: lease.childId === undefined,
              label: lease.label,
              owned,
              mine,
            })
          }
        }
      }
    } catch {
      /* one malformed lease must not block admission for everyone else */
    }
  }
  return conflicts
}

/** One actionable line naming the owner and both conflicting paths. */
function overlapMessage(conflicts) {
  const first = conflicts[0]
  const owner = typeof first.label === 'string' && first.label !== '' ? `subagent "${first.label}"` : 'another subagent'
  // A pending lease belongs to a task that is QUEUED, not running: naming it by a
  // child id it does not have yet would print "child undefined".
  const who = first.pending === true ? `${owner} (a queued delegation that has not started yet)` : `${owner} (child ${first.childId})`
  return `write scope refused: ${who} already holds ${scopeLabel(first.owned)}; `
    + `this task declared ${scopeLabel(first.mine)}, which overlaps. Wait for that child to end `
    + '(its lease is released on subagent/end), or declare non-overlapping scopes.'
}

/** A typed refusal the delegate tools map onto status="denied". */
function writeScopeError(conflicts) {
  const error = new Error(overlapMessage(conflicts))
  error.name = 'WriteScopeOverlapError'
  error.code = 'WRITE_SCOPE_OVERLAP'
  error.conflicts = conflicts.map(conflict => ({
    child: conflict.childId,
    // A queued (pending) task has no child id yet; the flag keeps the structured
    // result honest instead of publishing `child: undefined`.
    ...(conflict.pending === true ? { pending: true } : {}),
    label: conflict.label,
    path: scopeLabel(conflict.owned),
  }))
  return error
}

/**
 * A typed refusal for a scope that resolves outside the workspace root. The
 * delegate tools map it onto status="denied" with code WRITE_SCOPE_INVALID, and
 * `delegate_many` leaves the rest of the batch alone (this is a per-task refusal,
 * not a batch-level conflict).
 */
function writeScopeInvalidError(resolved) {
  const error = new Error(typeof resolved?.message === 'string' && resolved.message !== ''
    ? resolved.message
    : 'write scope refused: the declared scope is outside this task\'s workspace root')
  error.name = 'WriteScopeInvalidError'
  error.code = 'WRITE_SCOPE_INVALID'
  return error
}

/**
 * Consecutive "the child is not in `agents.get`" misses per lease key.
 *
 * `agents.get(childId)` going undefined does NOT prove the child is gone: a child
 * that has been created but has not yet entered the registry (or one that is
 * being re-created behind a resumed session) reads as undefined for a moment.
 * Releasing on a single miss dropped a LIVE writer's lease, which let a second
 * writer into the same files. Two consecutive misses are required; the first one
 * only logs, and any successful lookup clears the counter.
 */
const leaseMisses = new Map()

/** The grace window a first miss is remembered for; a later sweep is the second. */
const LEASE_MISS_GRACE_MS = 5_000

/** Sweep leases whose child is gone or whose TTL elapsed. Never throws. */
function sweepWriteLeases(ctx) {
  if (writeLeases.size === 0) return
  const now = Date.now()
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    agents = undefined
  }
  for (const [key, lease] of writeLeases) {
    try {
      // The hard TTL runs FIRST and covers PENDING leases too. It used to be
      // unreachable for them (the `childId === undefined` skip came first), so a
      // start that reserved and then wedged — a crash between reserve and promote,
      // a hung activation — held its paths until the process died.
      if (now - lease.at > LEASE_TTL_MS) {
        releaseWriteLease(key, lease.childId === undefined ? 'pending lease ttl expired' : 'ttl expired')
        continue
      }
      // Liveness only applies to a BOUND lease: `agents.get` cannot know a child in
      // the reserve→promote window, and a queued `delegate_many` task is pending by
      // design for as long as the batch runs.
      if (lease.childId === undefined) continue
      if (agents !== undefined && typeof agents.get === 'function' && agents.get(lease.childId) === undefined) {
        const previous = leaseMisses.get(key)
        const misses = (previous?.count ?? 0) + 1
        const firstAt = previous?.firstAt ?? now
        leaseMisses.set(key, { count: misses, firstAt })
        // Two consecutive misses AND the 5 s grace: a child that is briefly missing
        // right after creation keeps its lease. The old `|| misses >= 4` escape
        // dropped a LIVE writer with NO grace at all — four sweeps inside one burst
        // of admissions (each admission sweeps) was enough to release it.
        if (misses >= 2 && now - firstAt >= LEASE_MISS_GRACE_MS) {
          leaseMisses.delete(key)
          releaseWriteLease(key, `child no longer live (${misses} consecutive sweeps, ${now - firstAt}ms)`)
        } else {
          log(
            `write lease ${key}: child=${lease.childId} is not in agents.get (miss ${misses}, `
            + `${now - firstAt}ms since the first; a child can be briefly absent right after creation) — keeping the lease`,
          )
        }
      } else {
        if (leaseMisses.delete(key)) log(`write lease ${key}: child=${lease.childId} is live again; miss counter cleared`)
      }
    } catch {
      /* one bad lease must not stop the sweep */
    }
  }
}

/**
 * Build one provisional lease record (NOT yet in the map).
 *
 * Split out of `reserveWriteLease` so a `delegate_many` preflight can build the
 * whole batch and then register every lease in one synchronous block, before
 * the first child starts — the same record shape either way.
 */
function buildWriteLease(parentId, base, scopes, label, isolate) {
  const token = newLeaseToken()
  const lease = {
    token,
    parentId: String(parentId),
    childId: undefined,
    label: typeof label === 'string' && label !== '' ? label : '?',
    // An isolated writer claims NO path yet: until the worktree path is known it
    // must not deny a single call. `applyWorktreeToLease` fills this in.
    paths: isolate === true ? [] : scopes,
    isolate: isolate === true,
    cwd: base.value,
    at: Date.now(),
  }
  return { token, key: `pending:${token}`, lease, promoted: false, scopes }
}

/** Put a built provisional lease into the map. Synchronous by contract. */
function registerWriteLease(reservation) {
  writeLeases.set(reservation.key, reservation.lease)
  log(
    `write lease RESERVED ${reservation.key} parent=${reservation.lease.parentId} `
    + `paths=[${reservation.scopes.map(scopeLabel).join(', ')}]`
    + `${reservation.lease.isolate === true ? ' (isolated: paths deferred to the worktree)' : ''}`,
  )
}

/**
 * Tier 1 admission: check the new scope against every running write lease and
 * reserve a provisional lease, all synchronously (no await between check and
 * reservation), so two overlapping starts can never both pass.
 *
 * `isolate: true` (Tier 3) is the one exception: that writer will work on its own
 * git worktree, so the overlap refusal cannot apply — it is skipped, and the
 * lease starts with an EMPTY path set (filled in with the worktree path once
 * `worktrees.create` answers) so a half-registered writer never denies anybody.
 *
 * `delegate_many` does NOT come through here per task: its batch preflight
 * (`preflightBatchWriteLeases`) resolves every scope, tests the whole batch and
 * registers all leases at once, then hands each `startChild` its reservation.
 */
function reserveWriteLease(ctx, parentId, parent, kind, rawScope, label, isolate) {
  if (kind !== 'write') return undefined
  const base = workspaceScope(parent)
  if (base === undefined) {
    log('write lease SKIPPED: no workspace root for this delegation; mutual exclusion is off')
    return undefined
  }
  const resolved = resolveWriteScopes(rawScope, base)
  // M7: a scope that resolves OUTSIDE the workspace is refused, never widened.
  // This throws the typed WRITE_SCOPE_INVALID the delegate tools report as
  // status="denied" (one row, for `delegate_many`, not the whole batch).
  if (resolved.ok === false) throw writeScopeInvalidError(resolved)
  const scopes = resolved.scopes
  sweepWriteLeases(ctx)
  if (isolate === true) {
    log('write lease: isolate=true — Tier 1 overlap check SKIPPED (a private worktree keeps this writer apart)')
  } else {
    const conflicts = findWriteScopeConflicts(scopes)
    if (conflicts.length > 0) throw writeScopeError(conflicts)
  }

  const reservation = buildWriteLease(parentId, base, scopes, label, isolate)
  registerWriteLease(reservation)
  return reservation
}

/** Re-key a provisional lease onto the child session id it now belongs to. */
function promoteWriteLease(reservation, childId, name) {
  if (reservation === undefined) return
  try {
    const lease = reservation.lease
    writeLeases.delete(reservation.key)
    if (childId === undefined) {
      log(`write lease DROPPED (${reservation.key}): the activation returned no child id`)
      return
    }
    lease.childId = String(childId)
    if (typeof name === 'string' && name !== '') lease.label = name
    writeLeases.set(lease.childId, lease)
    reservation.promoted = true
    log(`write lease BOUND child=${lease.childId} parent=${lease.parentId} paths=[${lease.paths.map(scopeLabel).join(', ')}]`)
  } catch (error) {
    log(`write lease promote FAILED: ${error?.message}`)
  }
}

/** Drop one lease by key. Returns whether anything was released. Never throws. */
function releaseWriteLease(key, reason) {
  try {
    const id = String(key)
    const lease = writeLeases.get(id)
    if (lease === undefined) return false
    writeLeases.delete(id)
    leaseMisses.delete(id)
    log(
      `write lease RELEASED (${reason}) child=${lease.childId ?? '?'} parent=${lease.parentId} `
      + `paths=[${lease.paths.map(scopeLabel).join(', ')}]`,
    )
    return true
  } catch (error) {
    log(`write lease release FAILED: ${error?.message}`)
    return false
  }
}

/**
 * One lease → the payload its durable record carries. Never throws.
 *
 * Built from the LIVE claim (`lease.paths`), not from the caller's declared
 * scopes: an isolated writer's authoritative claim is its worktree, and a failed
 * worktree turns the lease back into a plain scoped lease
 * (`applyWorktreeToLease`). Storing the declared scopes would restore a claim the
 * child never actually held.
 */
function leaseRecordOf(lease) {
  try {
    if (lease === null || lease === undefined) return undefined
    const scopes = []
    for (const scope of Array.isArray(lease.paths) ? lease.paths : []) {
      if (scope === null || typeof scope !== 'object') continue
      if (typeof scope.value !== 'string' || scope.value === '') continue
      scopes.push({
        value: scope.value,
        dir: scope.dir === true,
        raw: typeof scope.raw === 'string' && scope.raw !== '' ? scope.raw : scope.value,
      })
      if (scopes.length >= 64) break
    }
    const record = { leased: true, isolate: lease.isolate === true, scopes }
    if (typeof lease.worktree === 'string' && lease.worktree !== '') record.worktree = lease.worktree
    return record
  } catch {
    return undefined
  }
}

/**
 * One recorded payload → a validated lease record, or undefined when it is not a
 * lease record this plugin wrote. Shape only: `value` is a normalized key and
 * `raw` is the human spelling that is re-resolved on restore.
 */
function leaseRecordFromPayload(data) {
  try {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
    // `leased: false` is a REAL answer: this child runs as kind="write" but this
    // plugin never leased it (a gate-defaulted kind, or a delegation that could
    // not resolve a workspace root). It must not be mistaken for a MISSING
    // record, which is a refusal.
    if (data.leased === false) return { leased: false }
    if (data.leased !== true) return undefined
    const scopes = []
    for (const entry of Array.isArray(data.scopes) ? data.scopes : []) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.value !== 'string' || entry.value === '') continue
      scopes.push({
        value: entry.value,
        dir: entry.dir === true,
        raw: typeof entry.raw === 'string' && entry.raw !== '' ? entry.raw : entry.value,
      })
      if (scopes.length >= 64) break
    }
    const record = { leased: true, isolate: data.isolate === true, scopes }
    if (typeof data.worktree === 'string' && data.worktree !== '') record.worktree = data.worktree
    // A scoped claim always has at least one entry; an empty one would "restore"
    // nothing, so it is unusable (and therefore a refusal) rather than a pass.
    if (scopes.length === 0 && record.isolate !== true) return undefined
    return record
  } catch {
    return undefined
  }
}

/**
 * The lease record in ONE session's OWN log, or undefined.
 *
 * Same read paths and fold rule as `kind`/`tools`/`skills`: the LAST record wins,
 * an unrecognized payload is ignored, and every read is guarded — the caller is
 * the serial `agent/created` listener, where a throw would reject the creation.
 */
function leaseRecordFromSessionLog(ctx, sessionId, knownSession) {
  for (const session of sessionCandidatesFor(ctx, sessionId, knownSession)) {
    try {
      const events = typeof session.ownEvents === 'function'
        ? session.ownEvents()
        : typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      let recorded
      for (const event of events) {
        if (event?.type !== LEASE_EVENT_TYPE) continue
        const record = leaseRecordFromPayload(event?.data)
        if (record !== undefined) recorded = record
      }
      if (recorded !== undefined) return recorded
    } catch (error) {
      log(`lease: record read FAILED for session=${String(sessionId)}: ${error?.message}`)
    }
  }
  return undefined
}

/**
 * Persist a writer's lease claim into its OWN log, at most once. Never rejects.
 *
 * Idempotent like {@link recordKindOnce}: an existing record is detected BEFORE
 * writing, so a re-created session can never grow a second claim that disagrees
 * with the first. An unavailable writer, a different Session class, or a throwing
 * append only logs — the child creation must go on.
 */
async function recordLeaseOnce(ctx, session, record, sessionId) {
  try {
    if (session === undefined || record === undefined) return false
    if (leaseRecordFromSessionLog(ctx, sessionId, session) !== undefined) {
      log(`lease: record already present for session=${String(sessionId)} — not appended again`)
      return false
    }
    const api = await pluginRecordApi()
    if (api === undefined) {
      log(`lease: appendPluginRecord unavailable; the lease of session=${String(sessionId)} is NOT durable`)
      return false
    }
    if (typeof api.SessionClass === 'function' && !(session instanceof api.SessionClass)) {
      log('lease: session module instance differs; refusing appendPluginRecord')
      return false
    }
    api.append(session, LEASE_EVENT_TYPE, record)
    const described = record.leased === true
      ? `scopes=[${record.scopes.map(scopeLabel).join(', ')}]`
        + `${record.worktree === undefined ? '' : ` worktree=${record.worktree}`}`
        + `${record.isolate === true ? ' (isolated)' : ''}`
      : 'leased=false'
    log(`lease: recorded ${described} on session=${String(sessionId)}`)
    return true
  } catch (error) {
    log(`lease: appendPluginRecord FAILED (creation unaffected): ${error?.message}`)
    return false
  }
}

/**
 * Rebuild a resumed writer's lease from its durable record.
 *
 * Returns the registered lease, or undefined when nothing could be restored (the
 * caller then marks the child as an UNLEASED writer, i.e. refuses its writes).
 * A same-process resume whose lease is still in the map keeps that lease and only
 * refreshes it: dropping a live claim on a `send_message` wake-up would hand the
 * files to another writer for as long as the child runs.
 */
function restoreWriteLease(childId, parentId, record, label, cwd) {
  try {
    if (record?.leased !== true) return undefined
    const key = String(childId)
    const existing = writeLeases.get(key)
    if (existing !== undefined) {
      existing.at = Date.now()
      log(`lease: resumed child=${key} still holds its lease in this process — refreshed, not re-registered`)
      return existing
    }
    const scopes = []
    for (const entry of Array.isArray(record.scopes) ? record.scopes : []) {
      // Re-resolve the human spelling, so a junction / 8.3 / case alias still lands
      // on the same key it did at creation; the recorded key is the fallback.
      const parsed = normalizeScopePath(entry?.raw, undefined) ?? normalizeScopePath(entry?.value, undefined)
      if (parsed === undefined) continue
      const scope = { value: parsed.value, dir: entry?.dir === true || parsed.dir === true, raw: parsed.raw }
      if (scopes.some(other => other.value === scope.value && other.dir === scope.dir)) continue
      scopes.push(scope)
    }
    if (scopes.length === 0) {
      log(`lease: resumed child=${key} carries a lease record with no usable scope — not restored (writes will be refused)`)
      return undefined
    }
    const conflicts = findWriteScopeConflicts(scopes, [key])
    if (conflicts.length > 0) {
      log(
        `lease: resumed child=${key} re-claims paths that ${conflicts.length} live lease(s) also hold; `
        + 'registering the claim anyway (the guard still refuses files owned by the OTHER child)',
      )
    }
    const lease = {
      token: newLeaseToken(),
      parentId: String(parentId ?? '?'),
      childId: key,
      label: typeof label === 'string' && label !== '' ? label : '?',
      paths: scopes,
      isolate: record.isolate === true,
      cwd: typeof cwd === 'string' && cwd.trim() !== '' ? cwd : scopes[0].value,
      at: Date.now(),
      restored: true,
    }
    const worktree = record.isolate === true ? worktreeDirScope(record.worktree) : undefined
    if (worktree !== undefined) {
      lease.worktree = worktree.raw
      // The worktree IS the claim (see {@link leaseRecordOf}), never a widening of it.
      lease.paths = [worktree]
    }
    writeLeases.set(key, lease)
    log(
      `lease: RESTORED child=${key} parent=${lease.parentId} paths=[${lease.paths.map(scopeLabel).join(', ')}]`
      + `${lease.isolate === true ? ' (isolated: writes confined to the worktree)' : ''}`,
    )
    return lease
  } catch (error) {
    log(`lease: restore FAILED for child=${String(childId)}: ${error?.message}`)
    return undefined
  }
}

/** A human label for one child, for lease messages. Never throws. */
function leaseLabelOf(childId) {
  try {
    const row = runs.get(String(childId))
    if (row !== undefined && typeof row.name === 'string' && row.name !== '') return row.name
  } catch {
    /* the run table is a convenience; the fallback below always works */
  }
  return `child ${String(childId).slice(0, 8)}`
}

/** The live Session object of one child, or undefined. Never throws. */
function sessionOfChild(ctx, childId) {
  try {
    if (childId === undefined || childId === null) return undefined
    for (const session of sessionCandidatesFor(ctx, String(childId), undefined)) return session
  } catch {
    /* a failed lookup only costs the durable record; the caller logs it */
  }
  return undefined
}

/**
 * Atomic write-lease admission for ONE `delegate_many` batch.
 *
 * Runs before any child starts and in one synchronous pass, so a conflicting
 * batch is refused as a whole (`results: []`, no child started) instead of
 * starting some children and denying the rest. Two kinds of overlap count:
 *
 *   - BATCH-INTERNAL: task A's effective scope vs task B's effective scope;
 *   - EXTERNAL: a task's effective scope vs a lease a RUNNING child already owns.
 *
 * Only `kind="write"` tasks that are not `isolate:true` take part in the overlap
 * test (`isolate:true` works on its own git worktree, so it cannot collide with
 * this workspace). Isolated writers still get a lease registered here, because
 * every lease of the batch is registered as ONE block before the first start,
 * then handed to `startChild` so it never re-checks against its own siblings.
 *
 * Returns `{ ok: true, reservations: [{ index, reservation }] }` on success and
 * `{ ok: false, message }` on a write-scope conflict. Never throws: an
 * unexpected failure rolls the registrations back and falls back to the
 * per-task admission inside `startChild` (a preflight bug must not block work).
 */
function preflightBatchWriteLeases(ctx, parentId, parent, tasks, names) {
  const registered = []
  try {
    const base = workspaceScope(parent)
    if (base === undefined) {
      log('delegate_many: preflight lease check SKIPPED (no workspace root for this delegation)')
      return { ok: true, reservations: [] }
    }
    const entries = []
    // Tasks whose `scope` resolves OUTSIDE the workspace root. Those tasks are
    // refused on their own row (WRITE_SCOPE_INVALID, M7) instead of widening to
    // the whole tree; they are skipped here, so no lease is registered for them
    // and `startChild` re-resolves the scope and throws the typed refusal.
    const refusedScopes = new Set()
    for (let index = 0; index < tasks.length; index += 1) {
      try {
        const spec = tasks[index]
        if (spec === null || typeof spec !== 'object') continue
        const kind = normalizeKind(spec.kind)
        if (kind !== 'write') continue
        const resolved = resolveWriteScopes(spec.scope, base)
        if (resolved.ok === false) {
          refusedScopes.add(index)
          log(`delegate_many: task #${index} REFUSED invalid write scope (WRITE_SCOPE_INVALID)`)
          continue
        }
        entries.push({
          index,
          label: typeof names?.[index] === 'string' && names[index] !== '' ? names[index] : `task #${index}`,
          isolate: spec.isolate === true,
          scopes: resolved.scopes,
        })
      } catch (error) {
        log(`delegate_many: preflight scope resolve FAILED for task #${index}: ${error?.message}`)
      }
    }
    sweepWriteLeases(ctx)
    // Pairwise batch-internal overlap first, then the running leases. Both are
    // collected so the refusal names every offending task and path.
    const internal = []
    const external = []
    const writable = entries.filter(entry => entry.isolate !== true)
    for (let left = 0; left < writable.length; left += 1) {
      for (let right = left + 1; right < writable.length; right += 1) {
        try {
          const a = writable[left]
          const b = writable[right]
          for (const owned of a.scopes) {
            for (const mine of b.scopes) {
              if (!scopesOverlap(owned, mine)) continue
              internal.push({ a, b, owned, mine })
            }
          }
        } catch (error) {
          log(`delegate_many: preflight pair check FAILED: ${error?.message}`)
        }
      }
    }
    for (const entry of writable) {
      try {
        for (const conflict of findWriteScopeConflicts(entry.scopes)) {
          external.push({ entry, conflict })
        }
      } catch (error) {
        log(`delegate_many: preflight running-lease check FAILED for task #${entry.index}: ${error?.message}`)
      }
    }
    if (internal.length > 0 || external.length > 0) {
      const reasons = []
      const paths = []
      const indexes = new Set()
      for (const clash of internal) {
        indexes.add(clash.a.index)
        indexes.add(clash.b.index)
        paths.push(scopeLabel(clash.owned), scopeLabel(clash.mine))
        reasons.push(
          `task #${clash.a.index} (${clash.a.label}) scope ${scopeLabel(clash.owned)} overlaps `
          + `task #${clash.b.index} (${clash.b.label}) scope ${scopeLabel(clash.mine)}`,
        )
      }
      for (const clash of external) {
        indexes.add(clash.entry.index)
        paths.push(scopeLabel(clash.conflict.owned), scopeLabel(clash.conflict.mine))
        const owner = typeof clash.conflict.label === 'string' && clash.conflict.label !== ''
          ? `subagent "${clash.conflict.label}" (child ${clash.conflict.childId})`
          : `child ${clash.conflict.childId}`
        reasons.push(
          `task #${clash.entry.index} (${clash.entry.label}) scope ${scopeLabel(clash.conflict.mine)} overlaps `
          + `${owner} holding ${scopeLabel(clash.conflict.owned)}`,
        )
      }
      const taskIndexes = [...indexes].sort((a, b) => a - b)
      const message = 'write scope conflict rejected the whole batch before any child started: '
        + `${reasons.slice(0, 3).join('; ')}${reasons.length > 3 ? `; and ${reasons.length - 3} more overlap(s)` : ''}. `
        + 'No subagent was started; declare disjoint scopes (or `isolate:true`) and retry.'
      log(`delegate_many: preflight lease check FAILED paths=${paths.join(',')} tasks=[${taskIndexes.join(',')}]`)
      return { ok: false, message }
    }
    log(`delegate_many: preflight lease check OK (${entries.length} write task${entries.length === 1 ? '' : 's'})`)
    // One block: every batch lease is registered BEFORE the first child starts,
    // so no later task of this batch can be denied by its own sibling.
    const reservations = []
    for (const entry of entries) {
      const reservation = buildWriteLease(parentId, base, entry.scopes, entry.label, entry.isolate)
      registerWriteLease(reservation)
      registered.push(reservation)
      reservations.push({ index: entry.index, reservation })
    }
    // `refusedScopes` is diagnostic only: those tasks never reach `startChild`, so
    // the per-task refusal is produced by the admission there (it re-resolves the
    // same scope and throws the same typed WRITE_SCOPE_INVALID).
    return { ok: true, reservations, refusedScopes: [...refusedScopes] }
  } catch (error) {
    // A preflight bug must never be the reason a batch cannot run: roll back
    // what was registered and let `startChild`'s per-task admission decide.
    for (const reservation of registered) releaseWriteLease(reservation.key, 'batch preflight failed')
    log(`delegate_many: preflight lease check FAILED (unexpected): ${error?.message}; falling back to per-task lease admission`)
    return { ok: true, reservations: [] }
  }
}

/**
 * EVERY file a write call names, as an array (empty when nothing is parseable).
 *
 * `file_path` / `path` / `filePath` name one file directly. An `apply_patch` blob
 * is a MULTI-FILE patch, so every `*** Update|Add|Delete File:` header counts —
 * and so does every `*** Move to:` target, because a move writes the destination.
 * Missing the later headers let a multi-file patch pass the lease guard with its
 * first (harmless) path while it edited a file another child owned.
 *
 * Duplicates are dropped. Moving the SAME file twice is one path; a move FROM a
 * leased path is also a write to it, so a `*** Move to:` source is kept as an
 * `Update File`/`Delete File` header by the patch format itself.
 *
 * `file_path` and a `patch` blob are MERGED, never treated as alternatives: both
 * name files this call writes, so policing one of them is no policing at all.
 */
function pathArgumentsOf(args) {
  try {
    let value = args
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return []
      }
    }
    if (value === null || typeof value !== 'object') return []
    const paths = []
    const add = (raw) => {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text === '' || paths.includes(text)) return
      paths.push(text)
    }
    for (const key of ['file_path', 'path', 'filePath']) {
      add(value[key])
    }
    // MERGE both sources instead of returning early. A call carrying BOTH
    // `file_path` and a `patch` used to be policed by `file_path` ONLY, so the
    // patch — i.e. the file that actually gets written — was never checked: a
    // one-argument bypass of the whole guard. Every named path is listed now, and
    // a mixed call whose parts cannot all be resolved is refused (see the guard).
    if (typeof value.patch === 'string') {
      // `[ \t]*` after the colon: the patch format is written by a model, so a
      // second space (or a tab) is normal and used to hide the header entirely.
      const header = /\*\*\* (?:Update|Add|Delete) File:[ \t]*([^\r\n]+)/g
      let match
      while ((match = header.exec(value.patch)) !== null) add(match[1])
      // `*** Move to:` writes its target, so it must be guarded too. (The header
      // is line-anchored: prose quoting the marker cannot smuggle a path in.)
      const move = /^[ \t]*\*\*\* Move to: ([^\r\n]+)/gm
      while ((match = move.exec(value.patch)) !== null) add(match[1])
    }
    return paths
  } catch {
    return []
  }
}

/**
 * Tier 2: deny a write tool call that lands inside ANOTHER child's lease.
 *
 * Runs on every tool call in the deployment, so the first two checks are the
 * cheap ones (no leases at all ⇒ return immediately; not a write tool ⇒ return
 * immediately).
 *
 * FAIL-CLOSED for a leased writer: once the caller is known to hold a write lease
 * (i.e. it IS a known write child), a path that cannot be determined — no
 * parseable `file_path`/`patch` header at all, or a path that does not resolve
 * against anything — is REFUSED with WRITE_SCOPE_VIOLATION instead of passing
 * through. "I could not tell which file this writes" is exactly the case where a
 * guard must say no. Every other caller (the root session, read/verify children)
 * is not policed at all, so a fail-closed rule can never deadlock the
 * orchestrator by denying the human's own session.
 *
 * Nothing here may throw or it would break every tool call, so the whole body is
 * wrapped.
 */
function guardWriteScope(ctx, execution) {
  try {
    // The cheap exits stay first: no lease AND no unleased-writer marker ⇒ nothing
    // to police. The marker alone still matters (it IS a refusal), so it must keep
    // the guard awake even when every real lease is gone.
    if (writeLeases.size === 0 && unleasedWriters.size === 0) return undefined
    const tool = typeof execution?.name === 'string' ? execution.name : ''
    if (!WRITE_TOOLS.has(tool)) return undefined
    const agent = execution?.agent
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return undefined
    const ownKey = String(sessionId)
    const own = writeLeases.get(ownKey)
    // Only leased writers are policed: the root session and read/verify children
    // may write freely (their work is not a delegated lease, and denying it
    // would deadlock the orchestrator).
    if (own === undefined) {
      // ...except a WRITER whose lease could not be restored (see
      // `unleasedWriters`): "I know you are a delegated writer but I cannot tell
      // which files are yours" is exactly the case a guard must refuse. Root and
      // read/verify children are never marked, so this can never deadlock the
      // orchestrator or a reader.
      const unleased = unleasedWriters.get(ownKey)
      if (unleased === undefined) return undefined
      const reason = 'write refused: this subagent runs as kind="write" but its write-scope lease could not be '
        + 'restored (' + unleased.reason + '). A delegated writer must hold a lease so concurrent writers cannot '
        + 'clobber each other, and this plugin will not guess which files are yours. Ask the parent to '
        + 're-delegate the task (a fresh delegation re-leases its scope) instead of continuing here.'
      log('write guard DENIED ' + tool + ' caller=' + ownKey + ': unleased writer (' + unleased.reason + ')')
      return { reason, info: { name: tool, code: 'WRITE_SCOPE_VIOLATION', reason } }
    }
    // A guarded call is a liveness proof: refresh the lease timestamp every time.
    // Written once at reservation, `at` turned the hard TTL into a real eviction for
    // any writer that stayed busy longer than the TTL (6 h): the clock measured
    // "time since start", not "time since the child last did anything".
    own.at = Date.now()

    /** Deny with the same typed shape every other refusal uses. */
    const refuse = (reason) => {
      log(`write guard DENIED ${tool} caller=${ownKey}: ${reason}`)
      return { reason, info: { name: tool, code: 'WRITE_SCOPE_VIOLATION', reason } }
    }

    const rawPaths = pathArgumentsOf(execution?.arguments)
    if (rawPaths.length === 0) {
      // M2: the caller is a known write child and no target can be determined.
      return refuse(
        `write refused: could not determine which file this ${tool} call writes (no parseable `
        + '`file_path` / `path` argument, and no apply_patch file header). A delegated writer '
        + 'must name every file it writes, so the write-scope leases stay enforceable.',
      )
    }

    const header = sessionHeaderOf(agent)
    const cwd = typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd : own.cwd
    const targets = []
    const unresolved = []
    for (const rawPath of rawPaths) {
      const target = normalizeScopePath(rawPath, cwd)
      if (target === undefined) unresolved.push(rawPath)
      else targets.push({ raw: rawPath, target })
    }
    if (targets.length === 0) {
      // M2 as well: paths were declared but none could be resolved.
      return refuse(
        `write refused: could not resolve the target path of this ${tool} call `
        + `(${unresolved.slice(0, 3).map(path => JSON.stringify(path)).join(', ')}). `
        + 'A delegated writer must name every file it writes, so the write-scope leases stay enforceable.',
      )
    }
    if (unresolved.length > 0) {
      // Mixed patch: refuse rather than police only the resolvable half, because
      // the unresolvable file could be the one another child owns.
      return refuse(
        `write refused: ${unresolved.length} path(s) of this ${tool} call could not be resolved `
        + `(${unresolved.slice(0, 3).map(path => JSON.stringify(path)).join(', ')}). `
        + 'A multi-file patch is only admitted when every file it names can be resolved.',
      )
    }

    sweepWriteLeases(ctx)
    // A sweep may have just released this caller's own (dead) lease.
    if (!writeLeases.has(ownKey)) return undefined

    // The plugin's OWN control surface is not a write target for a leased writer:
    // `matriline.paused` silently disables trimming for the whole product,
    // `state.json` carries other sessions' switches, and the package directory
    // carries this module. The sandbox does not cover it on its own — a portable
    // install can put the data dir inside the workspace the writer may use.
    const protectedScopes = pluginProtectedScopes()
    const intrusion = targets.find(({ target }) => protectedScopes.some(scope => scopeCovers(target.value, scope)))
    if (intrusion !== undefined) {
      return refuse(
        `write refused: ${JSON.stringify(intrusion.raw)} is inside this plugin's own state or package directory, `
        + 'which no delegated writer may modify: it would let a child disable the trimming gate, rewrite another '
        + "session's switch, or patch the plugin itself. Ask the root session to make this change instead.",
      )
    }

    // Tier 3 boundary: an isolated writer lives in its OWN checkout, so its lease
    // names that worktree and NOTHING else. "Owns nothing outside" has to be
    // ENFORCED here, not merely unclaimed: before this check, an isolated child
    // could send `write`/`edit`/`apply_patch` an ABSOLUTE path (or one with `..`)
    // straight into the parent's checkout, which is the single thing isolation
    // promises. Shells stay out of this rule: a `pwsh` command is invisible to a
    // tool guard (Tier 3 covers them with the worktree gate and the isolation
    // notice in the task text instead).
    if (own.isolate === true) {
      const boundary = isolateBoundary(own)
      // No boundary yet means the worktree has not been created, which is the
      // reserve→create window the global worktree gate is holding the call in.
      // Until it settles there is nothing to enforce — and once it FAILS,
      // `applyWorktreeToLease` turns the lease back into a plain scoped lease.
      if (boundary !== undefined) {
        const outside = targets.filter(({ target }) => !scopeCovers(target.value, boundary))
        if (outside.length > 0) {
          const named = outside.slice(0, 3).map(({ raw }) => JSON.stringify(raw)).join(', ')
          return refuse(
            'write refused: this subagent is isolated in its own git worktree (' + boundary.raw + '); '
            + named + (outside.length === 1 ? ' is' : ' are') + ' outside it. An isolated writer may only '
            + 'touch files inside its worktree — the parent checkout is off limits by design, which is what '
            + 'isolation buys the parent. Write the same path inside the worktree instead.',
          )
        }
      }
    }

    // Tier 3: inside a registered worktree, only that worktree's own lease is
    // authoritative. An ancestor "whole workspace" lease must not claim a
    // physically separate checkout (which is often nested under the repo root).
    const conflicts = []
    for (const { raw, target } of targets) {
      const insideWorktree = worktreeOwning(target.value)
      for (const [key, lease] of writeLeases) {
        try {
          if (lease.childId === undefined) continue
          if (String(lease.childId) === ownKey) continue
          if (insideWorktree !== undefined && lease.isolate !== true) continue
          for (const scope of lease.paths) {
            if (!scopeCovers(target.value, scope)) continue
            conflicts.push({ raw, target, lease, scope })
          }
        } catch {
          /* one bad lease must not deny a valid call */
        }
      }
    }
    if (conflicts.length === 0) return undefined

    const first = conflicts[0]
    const owner = typeof first.lease.label === 'string' && first.lease.label !== ''
      ? `${first.lease.label} (child ${first.lease.childId})`
      : `child ${first.lease.childId}`
    // Name EVERY conflicting path: a multi-file patch is refused as a whole, and
    // the caller has to know which of its files are somebody else's.
    const named = conflicts
      .map(conflict => `${conflict.raw} → ${scopeLabel(conflict.scope)} (child ${conflict.lease.childId})`)
    const reason = `write refused: ${named.slice(0, 4).join('; ')}${named.length > 4 ? `; and ${named.length - 4} more` : ''}. `
      + `Those paths belong to subagent ${owner}. That child owns those files until it ends; do not edit them. `
      + 'Ask the parent to hand this file to the same child, or wait for that lease to be released.'
    log(
      `write guard DENIED ${tool} paths=[${conflicts.map(conflict => conflict.target.value).join(',')}] `
      + `caller=${ownKey} owners=[${[...new Set(conflicts.map(conflict => conflict.lease.childId))].join(',')}]`,
    )
    return { reason, info: { name: tool, code: 'WRITE_SCOPE_VIOLATION', reason } }
  } catch (error) {
    log(`write guard FAILED (pass-through): ${error?.message}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Tier 3: worktree isolation (`isolate: true` on a write delegation)
//
// A `bash`/`pwsh` command is invisible to the Tier 2 guard, so the only physical
// answer is a separate checkout: `worktrees.create(agent, { name })` creates a
// git worktree AND switches the AGENT's session cwd into it, which is why it must
// run for the CHILD, and why it runs in the child's `agent/created` hook (after
// the trimming logic, so the tool surface and sandbox are already decided).
//
// Shape of the flow, because three places must agree:
//   - `startChild` sets the per-parent isolation slot before `startActivation`,
//     CAPTURES the attempt inside that slot and then awaits it after the slot is
//     released, so the parent's result is deterministic without serializing every
//     later dispatch of the same parent behind a worktree that can take 60 s;
//   - the `agent/created` hook only REGISTERS the intent. At that instant the
//     child's Cordis fiber is not active yet, and the service's final step
//     ("enter the checkout" → `workingDirectory.set`) calls
//     `fiber.assertActive()`, which throws `cannot create effect on inactive
//     context`. The creation therefore fires on the child's first `turn/start`
//     (or `step/start`) session event, when the fiber is alive — the first step
//     is only a model request, so the cwd still switches before any tool call;
//   - `settleChild` merges the recorded outcome into the result as `worktree`
//     (success) or `worktreeError` (failure) — mutually exclusive, absent when
//     `isolate` was not requested;
//   - a creation that answers AFTER the parent stopped waiting (or after the
//     child ended) is SUPERSEDED: its checkout is retained and logged, but it
//     never flips a result the parent already received, nor the write lease.
//
// Failure degrades, never blocks: no git repo, a duplicate branch name, or a
// missing `worktrees` bundle all leave the child running in the ORIGINAL cwd,
// with the error reported in `worktreeError`. A failure that left a checkout
// behind (the service says "Any created checkout and branch are retained") is
// cleaned up through the service's own non-force `removeCheckout`, and the
// `worktreeError` text says what was cleaned. The service never deletes a
// branch, so a retained branch is named in that same text.
// ---------------------------------------------------------------------------

/** Upper bound on how long a parent waits for `worktrees.create` to answer. */
const WORKTREE_WAIT_MS = 60_000

/** Git branch names stay comfortably under git's own limit. */
const WORKTREE_BRANCH_LIMIT = 40

/** The exact `worktreeError` text when the bundle is not installed. */
const WORKTREE_UNAVAILABLE = 'worktree service unavailable'

/** Isolation requested on a reader/verifier: ignored, but SAID so. */
const ISOLATE_IGNORED_NOTE = 'isolate ignored: only kind="write" runs in a private worktree'

/** `tools` given for a reader/verifier: it has a fixed whitelist, so it is ignored. */
const TOOLS_IGNORED_NOTE = 'tools ignored: kind="read"/"verify" always has its own fixed whitelist'

/** The worktree each child got, by child session id. */
const childWorktrees = new Map()

/** The isolation failure of each child, by child session id. */
const childWorktreeErrors = new Map()

/**
 * Checkouts whose child is gone (ended, or whose late creation the parent had
 * already reported as failed) but whose DIRECTORY must stay exempt from other
 * leases: the checkout is on disk and the human can still work in it. The Tier 3
 * exemption is about the PATH, not about a live lease, so forgetting the entry
 * when the child ended let an ancestor "whole workspace" lease deny writes in a
 * checkout the plugin itself created. Bounded to the most recent
 * {@link RETAINED_WORKTREE_LIMIT} checkouts: this is a diagnostic exemption, not
 * a second registry.
 */
const retainedWorktrees = new Map()

/** How many ended/superseded checkouts keep their Tier 3 exemption. */
const RETAINED_WORKTREE_LIMIT = 32

/** The isolation attempt in flight for one parent's serialized start window. */
const pendingWorktrees = new Map()

/**
 * The isolate outcome of one activation ({@link startChild} → `settleChild`).
 *
 * The per-child maps are cleaned on `subagent/end`, which can fire BEFORE the
 * settled result is assembled (a child that fails immediately). Keying the
 * outcome by the `started` activation object instead means the result always
 * carries it, and the WeakMap cannot leak.
 */
const startWorktrees = new WeakMap()

/**
 * The isolate request of a start window, per parent (read by the child hook).
 *
 * The request carries the session id RESERVED for this child
 * (`request.reservedChildId`), and the hook claims it only for that exact id —
 * see {@link beginWorktree}. A claim is one-shot (it deletes the entry), so a
 * second child of the same parent cannot take the request either.
 */
const pendingIsolation = new Map()

/**
 * Child session id → the isolation intent waiting for that child's context to go
 * live (`agent/created` runs too early for `workingDirectory.set`). Removed when
 * the attempt settles, when the child ends first, or when the start window
 * closes without a `turn/start`.
 */
const worktreeIntents = new Map()

/**
 * Child session id → the worktree promise the WRITE-TOOL GATE awaits.
 *
 * The worktree is created LAZILY (the child's first `turn/start`), so the
 * child's first write-class tool call can outrun the cwd switch and write into
 * the PARENT's checkout (measured on a live run). This map is the hard gate: the
 * global `tools/pre-execute` hook below waits for the child's own promise before
 * letting a write-class tool run. Keyed by the CHILD session id, so one child can
 * never be held up by another child's worktree.
 *
 * The value is `{ promise, degraded }`, NOT the bare promise. The entry is
 * removed in exactly one case — the worktree is READY — because then there is
 * nothing left to wait for. A timeout, an abort, or a failed creation keeps it
 * and only sets `degraded`: dropping it made every later write skip the gate
 * silently, so a second write landed in the parent's checkout with no wait and
 * no trace. A kept entry answers instantly once the creation settled, and
 * otherwise waits within the same 10 s ceiling, so the gate stays bounded per
 * call and can never hang.
 */
const worktreeReady = new Map()

/**
 * How long a write-class tool waits for its child's worktree before proceeding
 * in the original cwd. `worktrees.create` normally answers in well under a
 * second; the ceiling exists so a missing or wedged `worktrees` service can never
 * hang a child's tool calls (a timeout proceeds, and the parent's result still
 * carries `worktreeError`).
 */
const WORKTREE_GATE_TIMEOUT_MS = 10_000

/**
 * The tool names the gate holds back: the direct writers (reusing
 * {@link WRITE_TOOLS}) plus the two shells, which can write anything through a
 * command — exactly the case the Tier 2 path guard cannot see.
 */
const WORKTREE_GATE_TOOLS = new Set([...WRITE_TOOLS, 'pwsh', 'bash'])

/**
 * Prepended to an `isolate: true` delegation's task (the prompt fallback).
 *
 * The gate covers the five write-class tools; this covers what the gate cannot
 * see (a timed-out wait, a custom tool, a nested PTC call), so an isolated child
 * that still finds itself in the parent's directory CHECKS instead of writing
 * into it. Only the prompt is prefixed: the user's task text is preserved
 * verbatim after the notice.
 */
const ISOLATION_NOTICE = '[isolation] 你的工作目录会在几秒内切到一个私有 git worktree。写任何文件之前，先确认当前目录包含 `.agents/worktrees/`；若还不包含，等 2 秒再确认一次。'

/**
 * Wait (bounded) for one child's deferred worktree before a write-class tool.
 *
 * Returns the outcome for the caller's log only — `'ready'`, `'failed'`,
 * `'timeout'`, `'aborted'`, or `undefined` when this call was not gated at all
 * (not a write-class tool, no pending worktree for that session, no usable
 * session id). NEVER throws and never rejects: it runs inside a GLOBAL
 * pre-execute hook, where one exception would break every tool call in the
 * process. A timeout, an abort, or a failed creation always PROCEEDS — a child
 * must never be left unable to run a tool because a worktree never arrived.
 */
async function awaitWorktreeReady(exec) {
  try {
    const tool = typeof exec?.name === 'string' ? exec.name : ''
    if (!WORKTREE_GATE_TOOLS.has(tool)) return undefined
    if (worktreeReady.size === 0) return undefined
    const sessionId = sessionIdOf(exec?.agent)
    if (sessionId === undefined) return undefined
    const entry = worktreeReady.get(sessionId)
    if (entry === undefined) return undefined

    let timer
    let offAbort
    let outcome
    try {
      outcome = await Promise.race([
        // The creation itself never rejects, but a rejected/polyfilled promise
        // must still land here as a FAILURE instead of escaping this wait.
        Promise.resolve(entry.promise).then(
          value => value,
          error => ({ ok: false, reason: String(error?.message ?? error) }),
        ),
        new Promise((settle) => {
          timer = setTimeout(() => settle('timeout'), WORKTREE_GATE_TIMEOUT_MS)
          if (typeof timer?.unref === 'function') timer.unref()
          // The pre-execute contract requires an async gate to observe the
          // caller's cancellation, so an aborted call does not sit here.
          const signal = exec?.signal
          if (signal === undefined || typeof signal.addEventListener !== 'function') return
          if (signal.aborted === true) {
            settle('aborted')
            return
          }
          const onAbort = () => settle('aborted')
          signal.addEventListener('abort', onAbort, { once: true })
          offAbort = () => {
            try {
              signal.removeEventListener('abort', onAbort)
            } catch {
              /* an unusable signal cannot outlive this call */
            }
          }
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (offAbort !== undefined) offAbort()
    }

    // READY is the only outcome that drops the entry: the worktree is known, so
    // no later write has anything to wait for. Every other outcome KEEPS it and
    // records why, because the creation may still answer inside its 60 s ceiling
    // (the next write must be held until the checkout is known, or land in the
    // parent's checkout while the later writes run isolated), and because a
    // degraded entry is what a later log line can point at.
    if (outcome?.ok === true) {
      worktreeReady.delete(sessionId)
      log(`worktree gate: child=${sessionId} ready at ${String(outcome.path ?? '?')}`)
      return 'ready'
    }
    const reason = outcome === 'timeout'
      ? `no answer within ${WORKTREE_GATE_TIMEOUT_MS}ms`
      : outcome === 'aborted'
        ? 'the tool call was aborted while waiting'
        : String(outcome?.reason ?? 'worktree creation failed')
    // Logged once per child: the marker, not the repetition, is the signal.
    if (entry.degraded === undefined) {
      entry.degraded = reason
      log(`worktree gate: DEGRADED (child=${sessionId}: ${reason}) — this call proceeds in the original cwd; the entry is kept so later writes keep their bounded wait`)
    }
    if (outcome === 'timeout') return 'timeout'
    return outcome === 'aborted' ? 'aborted' : 'failed'
  } catch (error) {
    log(`worktree gate FAILED (passing through): ${error?.message}`)
    return undefined
  }
}

/**
 * The service's own wording when it leaves a half-finished checkout behind:
 * "Could not finish worktree <branch> at <path>. Any created checkout and branch
 * are retained. <cause>". That text is the only place the retained branch/checkout
 * is named, so cleanup reads it back.
 */
const RETAINED_WORKTREE = /Could not finish worktree (\S+) at (.+?)\. Any created checkout and branch are retained\./

/**
 * A git-safe branch name: lower-case `a-z0-9-` only, no leading/trailing `-`, at
 * most {@link WORKTREE_BRANCH_LIMIT} characters. Every illegal character is
 * folded to `-` (not dropped, so `a/b` stays readable as `a-b`); an input that
 * collapses to nothing falls back to `matriline-<childId[0..8]>`.
 */
function cleanBranchName(base, childId) {
  const fallback = () => {
    const tail = String(childId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
    return tail === '' ? 'matriline-child' : `matriline-${tail}`
  }
  let text = typeof base === 'string' ? base.trim().toLowerCase() : ''
  text = text.replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  if (text.length > WORKTREE_BRANCH_LIMIT) text = text.slice(0, WORKTREE_BRANCH_LIMIT).replace(/-+$/g, '')
  return text === '' ? fallback() : text
}

/** The `worktrees` service, or undefined when that bundle is not installed. */
function worktreeService(ctx) {
  try {
    const service = ctx.get('worktrees')
    if (service === undefined || service === null) return undefined
    if (typeof service.create === 'function') return service
    log('worktree: the worktrees service is present but has no create()')
  } catch (error) {
    log(`worktree: service lookup FAILED: ${error?.message}`)
  }
  return undefined
}

/** The directory scope of one worktree path, as the Tier 2 lease needs it. */
function worktreeDirScope(path) {
  try {
    if (typeof path !== 'string' || path.trim() === '') return undefined
    const parsed = normalizeScopePath(path, undefined)
    if (parsed === undefined) return undefined
    return { value: parsed.value, dir: true, raw: path.trim() }
  } catch {
    return undefined
  }
}

/** The subtree an `isolate: true` lease is confined to, or undefined while unknown. */
function isolateBoundary(lease) {
  try {
    if (lease === null || lease === undefined) return undefined
    if (typeof lease.worktree === 'string' && lease.worktree.trim() !== '') return worktreeDirScope(lease.worktree)
    // `paths` IS the settled claim: `applyWorktreeToLease` replaces the declared
    // scopes with the single worktree directory, so a one-entry isolate lease is
    // its own boundary even when `worktree` was lost to a process restart.
    if (lease.isolate === true && Array.isArray(lease.paths) && lease.paths.length === 1) {
      const only = lease.paths[0]
      if (only !== null && typeof only === 'object' && typeof only.value === 'string') {
        return { value: only.value, dir: true, raw: typeof only.raw === 'string' && only.raw !== '' ? only.raw : only.value }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The deepest registered worktree containing `path`, or undefined. Never throws.
 *
 * Both the live and the RETAINED registrations are consulted, and each one
 * carries its normalized scope ({@link withWorktreeScope}): this runs once per
 * write-class tool call and target, and re-normalizing the same checkout path
 * (realpath + case folding) on every call was pure overhead.
 */
function worktreeOwning(path) {
  let best
  const consider = (info) => {
    const scope = info?.scope
    if (scope === undefined) return
    if (!scopeCovers(path, scope)) return
    if (best === undefined || scope.value.length > best.value.length) best = scope
  }
  try {
    for (const info of childWorktrees.values()) consider(info)
    for (const info of retainedWorktrees.values()) consider(info)
  } catch {
    return undefined
  }
  return best
}

/** One registration: the checkout plus its NORMALIZED scope, computed once. */
function withWorktreeScope(worktree) {
  return { ...worktree, scope: worktreeDirScope(worktree?.path) }
}

/** Remember one isolation outcome for a child. Idempotent in both directions. */
function recordWorktree(childId, outcome) {
  try {
    if (childId === undefined || childId === null) return
    const key = String(childId)
    if (outcome === undefined) return
    if (outcome.ok === true && outcome.worktree !== undefined) {
      childWorktrees.set(key, withWorktreeScope(outcome.worktree))
      retainedWorktrees.delete(key)
      childWorktreeErrors.delete(key)
      return
    }
    childWorktrees.delete(key)
    childWorktreeErrors.set(key, String(outcome.error ?? 'worktree creation failed'))
  } catch (error) {
    log(`worktree: record FAILED: ${error?.message}`)
  }
}

/**
 * Keep one checkout's Tier 3 exemption once nothing can report it any more: the
 * child ended, or the creation answered after its parent already reported
 * `worktreeError`. Never throws, never grows past {@link RETAINED_WORKTREE_LIMIT}
 * (the oldest entry is dropped first: a Map re-inserts a re-`set` key at the end).
 */
function retainWorktree(childId, worktree, reason) {
  try {
    const key = String(childId ?? '?')
    retainedWorktrees.delete(key)
    retainedWorktrees.set(key, withWorktreeScope(worktree))
    while (retainedWorktrees.size > RETAINED_WORKTREE_LIMIT) {
      const oldest = retainedWorktrees.keys().next()
      if (oldest.done === true) break
      retainedWorktrees.delete(oldest.value)
    }
    log(`worktree: child=${key} checkout ${String(worktree?.path ?? '?')} (branch ${String(worktree?.branch ?? '?')}) retained (${reason})`)
  } catch (error) {
    log(`worktree: retain FAILED: ${error?.message}`)
  }
}

/**
 * The `worktree` / `worktreeError` fields of one result. Mutually exclusive, and
 * both absent when the delegation never asked for isolation (or was not a
 * writer), because nothing was ever recorded for that child.
 */
function worktreeResultFields(childId) {
  try {
    if (childId === undefined || childId === null) return {}
    const key = String(childId)
    const worktree = childWorktrees.get(key)
    if (worktree !== undefined) return worktreeFieldsFromOutcome({ ok: true, worktree })
    const error = childWorktreeErrors.get(key)
    if (error !== undefined) return { worktreeError: error }
  } catch (error) {
    log(`worktree: result fields FAILED: ${error?.message}`)
  }
  return {}
}

/**
 * One isolation outcome → the result fields (`worktree` XOR `worktreeError`).
 * `baseCommit` is always a string so the output schema never sees a hole.
 */
function worktreeFieldsFromOutcome(outcome) {
  if (outcome?.ok === true && outcome.worktree !== undefined) {
    const worktree = outcome.worktree
    return {
      worktree: {
        branch: String(worktree.branch ?? ''),
        path: String(worktree.path ?? ''),
        baseCommit: String(worktree.baseCommit ?? ''),
      },
    }
  }
  return { worktreeError: String(outcome?.error ?? 'worktree creation failed') }
}

/** The fields recorded on one activation handle, or {} when it had no worktree. */
function startWorktreeFields(started) {
  try {
    if (started === null || started === undefined || typeof started !== 'object') return {}
    return startWorktrees.get(started) ?? {}
  } catch {
    return {}
  }
}

/**
 * Point a write lease at the child's own worktree.
 *
 * The LEASE OBJECT is passed (not its map key) because the hook may finish the
 * creation before `promoteWriteLease` re-keys it: both callers mutate the same
 * object, so the claim is correct whichever runs first. A failed creation falls
 * back to the scopes the caller declared, i.e. exactly the pre-Tier-3 behavior.
 */
function applyWorktreeToLease(lease, outcome, fallbackScopes) {
  try {
    if (lease === undefined || lease === null) return
    if (outcome?.ok === true) {
      const scope = worktreeDirScope(outcome.worktree?.path)
      if (scope !== undefined) {
        lease.paths = [scope]
        lease.isolate = true
        lease.worktree = scope.raw
        log(`write lease child=${lease.childId ?? '?'} scoped to its worktree ${scope.raw}`)
        return
      }
    }
    if (Array.isArray(fallbackScopes) && fallbackScopes.length > 0
      && !(lease.paths.length === 1 && lease.paths[0]?.value === fallbackScopes[0]?.value)) {
      lease.paths = fallbackScopes
      lease.isolate = false
      delete lease.worktree
      log(`write lease child=${lease.childId ?? '?'}: no worktree, scoped to [${fallbackScopes.map(scopeLabel).join(', ')}]`)
    }
  } catch (error) {
    log(`worktree: lease update FAILED: ${error?.message}`)
  }
}

/**
 * Await one isolation attempt with a ceiling. Never throws, never hangs.
 *
 * The ceiling is a DECISION about the RESULT, not the end of the attempt: the
 * creation may still fire later (a child can sit behind a long parent turn and
 * reach its first `turn/start` after this wait gave up). Timeouts are therefore
 * marked with `timedOut` and the caller supersedes the intent, so a late
 * checkout can no longer flip the result it already reported.
 */
async function awaitWorktree(promise) {
  if (promise === undefined) return undefined
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, timedOut: true, error: `worktree creation did not answer within ${WORKTREE_WAIT_MS}ms` }),
          WORKTREE_WAIT_MS,
        )
        if (typeof timer?.unref === 'function') timer.unref()
      }),
    ])
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Resolve and forget one intent, exactly once. Never throws. */
function settleWorktreeIntent(intent, outcome) {
  if (intent === undefined || intent.settled === true) return
  intent.settled = true
  try {
    worktreeIntents.delete(intent.key)
  } catch {
    /* the map cannot fail; keep the resolve below reachable */
  }
  // Gap 1 (hard gate): the write-tool gate's own deferred promise is settled
  // here, the ONE funnel every isolation attempt passes through. A gate call
  // already awaiting it still gets the value. The entry is dropped only when the
  // worktree is READY; a failed attempt keeps it with the reason, which is what
  // keeps a later write inside the gate instead of letting it run blind.
  try {
    const readyResolve = intent.readyResolve
    if (typeof readyResolve === 'function') {
      const entry = worktreeReady.get(intent.key)
      readyResolve(
        outcome?.ok === true && outcome.worktree !== undefined
          ? {
              ok: true,
              branch: String(outcome.worktree.branch ?? ''),
              path: String(outcome.worktree.path ?? ''),
            }
          : { ok: false, reason: String(outcome?.error ?? 'worktree creation failed') },
      )
      if (entry !== undefined) {
        // Ready: nothing is left to wait for, so the entry goes. Failed: the
        // entry STAYS and carries the reason, so the next write still passes
        // through the gate (and is told) instead of running blind; `subagent/end`
        // drops it with the child.
        if (outcome?.ok === true && outcome.worktree !== undefined) worktreeReady.delete(intent.key)
        else if (entry.degraded === undefined) entry.degraded = String(outcome?.error ?? 'worktree creation failed')
      }
    }
  } catch (error) {
    log(`worktree: gate settle FAILED: ${error?.message}`)
  }
  try {
    intent.resolve(outcome)
  } catch (error) {
    log(`worktree: settle FAILED: ${error?.message}`)
  }
}

/**
 * Mark one intent SUPERSEDED: its outcome can no longer change any result.
 *
 * `runWorktreeCreate` is the only place a create can still answer after the
 * parent stopped waiting (the 60 s ceiling) or after the child ended, and a late
 * answer must not rewrite history: the parent was told `worktreeError` at the
 * only moment it asked. The checkout is retained instead — exempt from other
 * leases and named in the log — so a human can still find and use it.
 */
function supersedeWorktreeIntent(childId, reason) {
  try {
    if (childId === undefined || childId === null) return
    const intent = worktreeIntents.get(String(childId))
    if (intent === undefined || intent.settled === true) return
    if (intent.superseded !== undefined) return
    intent.superseded = reason
    log(`worktree: child=${String(childId)} superseded (${reason}); a late checkout will only be retained`)
  } catch (error) {
    log(`worktree: supersede FAILED: ${error?.message}`)
  }
}

/**
 * Clean up a checkout the service reports it retained.
 *
 * The service removes a checkout only through its own non-force `removeCheckout`,
 * which needs the saved identity (`path`, `branch`, `repositoryRoot`); the branch
 * and the checkout path are read back out of the failure text because the service
 * does not report them structurally. `repositoryRoot` is not in that text either,
 * so the child's original cwd and its nearest ancestors are tried in turn — the
 * service verifies the identity with `git rev-parse --show-toplevel`, so a wrong
 * guess is a no-op. The branch is NEVER deleted (the service does not offer that);
 * the returned note is appended to `worktreeError` so the caller knows what stayed.
 *
 * Never throws.
 */
async function cleanupRetainedWorktree(ctx, intent, message) {
  try {
    const match = RETAINED_WORKTREE.exec(String(message ?? ''))
    if (match === null) return ''
    const branch = match[1]
    const path = match[2]
    const service = worktreeService(ctx)
    const session = intent?.agent?.session
    if (service === undefined || typeof service.removeCheckout !== 'function' || session === undefined) {
      log(`worktree: cleanup unavailable; checkout ${path} and branch ${branch} retained`)
      return ` (cleanup unavailable: checkout ${path} and branch ${branch} retained)`
    }
    for (const repositoryRoot of repositoryRootCandidates(intent.fallbackCwd)) {
      try {
        const removed = await service.removeCheckout(
          session,
          { path, branch, baseCommit: '', repositoryRoot },
          new AbortController().signal,
          () => true,
        )
        if (removed === true) {
          log(`worktree: removed the retained checkout ${path} (branch ${branch} kept)`)
          return ` (cleanup: checkout removed; branch ${branch} retained — the worktrees service never deletes branches)`
        }
      } catch (error) {
        log(`worktree: cleanup attempt with repositoryRoot=${repositoryRoot} FAILED: ${error?.message}`)
      }
    }
    log(`worktree: cleanup FAILED; checkout ${path} and branch ${branch} retained`)
    return ` (cleanup FAILED: checkout ${path} and branch ${branch} retained)`
  } catch (error) {
    log(`worktree: cleanup FAILED: ${error?.message}`)
    return ' (cleanup FAILED: the retained checkout and branch could not be inspected)'
  }
}

/** Candidate source repositories for a cleanup: the cwd and its ancestors. */
function repositoryRootCandidates(cwd) {
  const candidates = []
  try {
    if (typeof cwd !== 'string' || cwd.trim() === '') return candidates
    let current = cwd.trim()
    for (let depth = 0; depth < 5; depth += 1) {
      if (current === '' || candidates.includes(current)) break
      candidates.push(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  } catch {
    /* best effort: an unreadable cwd means "no cleanup attempt" */
  }
  return candidates
}

/** Create one child's worktree now that its context is live. Never throws. */
async function runWorktreeCreate(ctx, intent) {
  const childId = intent.key
  const request = intent.request
  const startedAt = Date.now()
  let outcome
  try {
    const service = worktreeService(ctx)
    if (service === undefined) {
      outcome = { ok: false, error: WORKTREE_UNAVAILABLE }
    } else {
      const branch = cleanBranchName(request.branchBase, childId)
      log(`worktree: creating branch=${branch} for child=${childId}`)
      const created = await service.create(intent.agent, { name: branch }, request.signal)
      if (created === null || typeof created !== 'object'
        || typeof created.path !== 'string' || created.path.trim() === '') {
        outcome = { ok: false, error: 'worktrees.create returned no usable path' }
      } else {
        outcome = {
          ok: true,
          worktree: {
            branch: typeof created.branch === 'string' && created.branch !== '' ? created.branch : branch,
            path: created.path,
            baseCommit: typeof created.baseCommit === 'string' ? created.baseCommit : '',
            repositoryRoot: typeof created.repositoryRoot === 'string' ? created.repositoryRoot : '',
          },
        }
      }
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    const cleanup = await cleanupRetainedWorktree(ctx, intent, message)
    outcome = { ok: false, error: `${message}${cleanup}` }
  }
  if (outcome.ok === true) {
    log(
      `worktree: created branch=${outcome.worktree.branch} path=${outcome.worktree.path} `
      + `for child=${childId} (${Date.now() - startedAt}ms)`,
    )
  } else {
    log(`worktree: FAILED child=${childId}: ${outcome.error} — the child keeps the original cwd`)
  }
  if (intent.superseded !== undefined) {
    // The parent already stopped waiting (or the child already ended): the
    // registry and the lease describe a DECIDED child, so a late answer may not
    // flip them back to "isolated". A success is retained (see
    // `retainWorktree`) so its checkout keeps the Tier 3 exemption and shows up
    // in the log for a human; a late failure adds nothing at all.
    if (outcome.ok === true && outcome.worktree !== undefined) {
      retainWorktree(childId, outcome.worktree, `superseded: ${intent.superseded}`)
    } else {
      log(`worktree: child=${childId} superseded (${intent.superseded}); late failure ignored: ${outcome.error}`)
    }
  } else {
    recordWorktree(childId, outcome)
    applyWorktreeToLease(request.lease, outcome, request.scopes)
  }
  settleWorktreeIntent(intent, outcome)
  return outcome
}

/** Fire a pending intent once its child's context is live. Never throws. */
function fireWorktreeIntent(ctx, intent) {
  try {
    if (intent === undefined || intent.started === true || intent.settled === true) return
    intent.started = true
    // `void` alone left a rejected creation as an unhandled rejection AND kept
    // the intent (and the write gate that awaits it) pending forever. The
    // settle funnel is idempotent, so a failure that an inner guard already
    // settled is not settled twice.
    void runWorktreeCreate(ctx, intent).catch((error) => {
      const message = String(error?.message ?? error)
      log(`worktree: creation FAILED (child=${intent.key}): ${message}`)
      settleWorktreeIntent(intent, { ok: false, error: message })
    })
  } catch (error) {
    log(`worktree: start FAILED: ${error?.message}`)
  }
}

/**
 * Register the isolation intent for a freshly created child. Called from the
 * child's `agent/created` hook, AFTER the trimming logic.
 *
 * It deliberately does NOT call `worktrees.create` here: at `agent/created` the
 * child's fiber is not active, and the service's "enter the checkout" step calls
 * `fiber.assertActive()` (`cannot create effect on inactive context`). The actual
 * creation fires from the child's first `turn/start` / `step/start` — see
 * {@link fireWorktreeIntent}. Returns nothing and never throws: a hook exception
 * would reject the whole child creation, so every path is caught.
 */
function beginWorktree(ctx, agent, header) {
  try {
    const parentId = header?.parentSession
    const childId = header?.id
    if (parentId === undefined || childId === undefined) return
    const request = pendingIsolation.get(String(parentId))
    if (request === undefined) return

    const key = String(childId)
    // PRECISE CLAIM: the request names the session id RESERVED in the
    // `startActivation` spec, so only THAT child can take it. Matching by parent
    // alone let any other child of the same parent (the official `subagent`
    // tool, a workflow, another plugin) steal the intent — running in someone
    // else's checkout and leaving this delegation without one. A child that is
    // not the reserved one keeps its own cwd and gets no worktree: it is not
    // this delegation's child, so there is nothing to report either.
    //
    // A backend that cannot reserve (`prepareContinuable` missing) arms no
    // reserved id, and the claim falls back to the old parent-wide match; the
    // one-shot delete below still limits it to the FIRST child of this window.
    const reserved = request.reservedChildId
    if (reserved !== undefined && key !== String(reserved)) return
    pendingIsolation.delete(String(parentId))

    let resolve
    const promise = new Promise((settle) => { resolve = settle })
    pendingWorktrees.set(String(parentId), promise)
    // Gap 1 (hard gate): the write-tool gate awaits THIS promise, so a write
    // that races the deferred creation waits instead of landing in the parent's
    // checkout. Resolved by `settleWorktreeIntent`, which also marks the entry
    // `degraded` on failure; the entry itself is dropped on ready (or by the
    // child's `subagent/end`), never merely because a wait gave up.
    let resolveReady
    const ready = new Promise((settle) => { resolveReady = settle })
    worktreeReady.set(key, { promise: ready, degraded: undefined })
    worktreeIntents.set(key, {
      key,
      agent,
      request,
      started: false,
      settled: false,
      // Set by {@link supersedeWorktreeIntent} once the parent's result can no
      // longer be changed by this attempt; a late create is then retained only.
      superseded: undefined,
      resolve,
      readyResolve: resolveReady,
      // The pre-switch cwd: the source repository a retained checkout belongs to.
      fallbackCwd: typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined,
    })
    log(`worktree: deferred for child=${key} (created at its first turn/start — agent/created has no active context)`)
  } catch (error) {
    log(`worktree: hook FAILED (child keeps the original cwd): ${error?.message}`)
  }
}

/** Resolve the calling agent and the in-process subagent provider. Throws. */
function preflight(ctx, exec) {
  const parent = exec?.agent
  if (parent === undefined) throw new Error('delegate requires a calling agent')
  const subagents = ctx.get('subagents')
  if (subagents === undefined) throw new Error('delegate: subagents service unavailable')
  const providerName = ['spawn', 'local', 'in-process']
    .find(candidate => subagents.getProvider(candidate) !== undefined)
  if (providerName === undefined) throw new Error('delegate: no in-process subagent provider')
  const parentId = parent.session.header.id
  return { parent, subagents, providerName, parentId }
}

/**
 * A session id RESERVED for one child, so its isolation intent is claimed by an
 * exact id instead of by parent (see {@link beginWorktree}).
 *
 * The host's subagent manager accepts a caller-provided `childId` for a LOCAL
 * backend and returns that same id from the activation, so the reservation is
 * checkable after the fact too. `randomUUID` is a Node global; the fallback only
 * has to be unique enough to pass the host's `assertChildIdAvailable`.
 */
function reserveChildId() {
  try {
    const uuid = globalThis.crypto?.randomUUID
    if (typeof uuid === 'function') return String(uuid.call(globalThis.crypto))
  } catch {
    /* fall through to the counter below */
  }
  return `matriline-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

/**
 * Whether this backend can be handed a reserved child id.
 *
 * `startActivation` REJECTS a `childId` for a provider without
 * `prepareContinuable` (`UNSUPPORTED_CAPABILITY`), and that would fail the whole
 * delegation instead of only losing its isolation. Only the in-process backends
 * (`spawn`, `fork`) have that capability, which is exactly the set this plugin
 * uses; the check keeps a future backend from turning an isolation request into
 * a failed `delegate` call.
 */
function providerAcceptsReservedChildId(subagents, providerName) {
  try {
    if (subagents === undefined || typeof subagents.getProvider !== 'function') return false
    const provider = subagents.getProvider(providerName)
    return provider !== undefined && provider !== null && typeof provider.prepareContinuable === 'function'
  } catch {
    return false
  }
}

/**
 * Start ONE child. The kind slot is set and cleared around the activation only,
 * so callers settle any number of children in parallel afterwards.
 *
 * Tier 1 lives here on purpose: the write lease is checked and reserved INSIDE
 * the same per-parent slot window as the kind slot, synchronously, so two
 * overlapping write starts from one parent cannot both slip past the check.
 * The provisional lease is bound to the child id as soon as the activation
 * reports it; a start failure releases it in `finally`.
 *
 * Tier 3 lives here too: the isolation slot is set just before the activation
 * (the child's `agent/created` hook registers the intent, claimed by the child id
 * RESERVED in the activation spec), the attempt is captured inside the window and
 * awaited AFTER the slot is released, so the parent's result is deterministic
 * without serializing its next dispatch behind a worktree. The creation itself
 * fires on the child's first `turn/start`, i.e. while that await is pending. A
 * failed worktree never fails this function: the child is already created and
 * keeps its original cwd.
 */
async function startChild(ctx, options) {
  const { parentId, parent, subagents, providerName, task, kind, name, signal, scope, agentOptions, isolate, skills, toolsProfile } = options
  // Gap 1 (prompt fallback): an isolated writer is TOLD to verify its cwd before
  // writing, so a tool the gate cannot see (or a timed-out wait) still ends in a
  // check rather than in the parent's checkout. The caller's task is preserved
  // verbatim after the notice and only the PROMPT carries it — never the label,
  // the duplicate fingerprint, or any result field.
  const originalTask = String(task ?? '')
  const promptText = isolate === true ? `${ISOLATION_NOTICE}\n\n${originalTask}` : originalTask
  if (isolate === true) log('task prefixed with isolation notice')
  const wantsWorktree = isolate === true && kind === 'write'
  // A reserved child id is only offered to a LOCAL backend: `startActivation`
  // throws UNSUPPORTED_CAPABILITY when `childId` is given to a provider without
  // `prepareContinuable`, which would fail the whole delegation instead of only
  // its isolation. The in-process `spawn` / `fork` providers both have it.
  const reservedChildId = wantsWorktree && providerAcceptsReservedChildId(subagents, providerName)
    ? reserveChildId()
    : undefined
  const window = await withKindSlot(parentId, async () => {
    pendingKind.set(parentId, kind)
    // The `skill` tool drags a ~3,000-character catalog into every request as an
    // injected `user/message`. A delegated child gets a self-contained brief, so
    // it normally needs no catalog. `skills: true` keeps the tool, and pays for
    // it with one prompt-cache miss: the catalog message changes the prefix.
    pendingSkills.set(parentId, skills === true)
    // The `tools` profile travels the same slot: `agent/created` fires inside
    // `startActivation`, before it returns, so it is the only way the child hook
    // can learn what the caller asked for (`undefined` ⇒ the write default).
    pendingTools.set(parentId, toolsProfile)
    // Tier 3 separates WRITERS only (`wantsWorktree` above): a reader/verifier
    // has nothing to isolate, and the caller is told so in its summary.
    let reservation
    let childId
    let started
    let worktreePromise
    try {
      // `delegate_many` passes the lease its batch preflight already registered
      // (all leases of the batch are registered in one block before the first
      // start), so this task is never re-checked against its own siblings. A
      // single `delegate` — and every other caller — passes none and reserves
      // here exactly as before, check-before-reserve inside the slot window.
      reservation = kind === 'write' && options.reservation !== undefined
        ? options.reservation
        : reserveWriteLease(ctx, parentId, parent, kind, scope, name, wantsWorktree)
      // The child's own `agent/created` hook fires INSIDE `startActivation` below,
      // and it is the only place that can append to that child's own log. The
      // reservation rides the same slot bus as kind/skills/tools so the hook can
      // write the durable lease record; the lease OBJECT itself stays authoritative
      // for the live scopes.
      if (reservation !== undefined) pendingLeaseRecords.set(parentId, reservation)
      if (wantsWorktree) {
        // The hook can only learn "this child was asked to isolate" through this
        // slot; the worktree promise comes back through `pendingWorktrees`.
        // `reservedChildId` is the CLAIM KEY: only the child created under that
        // exact session id may take the request (see `beginWorktree`).
        pendingIsolation.set(parentId, {
          branchBase: name,
          scopes: reservation?.scopes,
          lease: reservation?.lease,
          signal,
          reservedChildId,
        })
      }
      started = await subagents.startActivation({
        provider: providerName,
        label: String(task ?? 'delegation').slice(0, 48),
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
        // Reserved identity: the host creates the LOCAL child under THIS session
        // id (`spec.childId ?? randomUUID()`), which is what makes the isolation
        // intent claimable by exact id. Omitted for a backend that cannot take
        // one, so an isolation request never becomes a failed delegation.
        ...(reservedChildId === undefined ? {} : { childId: reservedChildId }),
        prompt: [{ type: 'text', text: promptText }],
        parent,
        delivery: 'parent',
        // Model selection is orthogonal to `kind`: the runtime merges these
        // options OVER the parent's route, so a partial selection (for example
        // only `reasoningEffort`) keeps inheriting the parent's model/provider.
        // Omitted entirely ⇒ the existing inherit-everything path is untouched.
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(signal === undefined ? {} : { signal }),
      })
      childId = childIdOf(started)
      promoteWriteLease(reservation, childId, started?.name)
      // Captured BEFORE the `finally` drops the map: the creation may still be
      // pending (it fires on the child's first `turn/start`) and this promise is
      // the only handle left to it once this window closes.
      if (wantsWorktree) worktreePromise = pendingWorktrees.get(parentId)
      return { started, reservation, childId, worktreePromise }
    } finally {
      pendingKind.delete(parentId)
      pendingSkills.delete(parentId)
      pendingTools.delete(parentId)
      pendingIsolation.delete(parentId)
      pendingWorktrees.delete(parentId)
      pendingLeaseRecords.delete(parentId)
      // The "never reached turn/start" settlement is deliberately NOT here.
      // Closing this window says nothing about the child's first turn: that starts
      // AFTER `startActivation` returns, and a child queued behind a long parent
      // turn can take far longer than the slot. Judging here killed the intent of
      // every child that had not spoken yet (and, now that the wait moved out of
      // this window, it would kill every child's intent before its own trigger
      // could fire). `subagent/end` is the only place that can honestly say
      // "this child never started".
      // A refusal never reserved, a successful start already promoted; only the
      // "activation threw after reserving" path (and a missing childId) reaches
      // this release, so no lease can leak from a failed dispatch.
      if (reservation !== undefined && reservation.promoted !== true) {
        releaseWriteLease(reservation.key, 'start failed')
      }
    }
  })
  const { started, reservation, childId } = window
  if (!wantsWorktree) return started

  // Tier 3: the wait happens OUTSIDE the per-parent slot. The creation spans the
  // child's first `turn/start` and is ceiling-bounded at 60 s; holding the slot
  // for that serialized every later dispatch of the same parent behind work that
  // nobody could speed up. Nothing after `startActivation` touches the slot, and
  // the lease is already promoted onto the child id, so `applyWorktreeToLease`
  // below mutates the LIVE lease object — the one `guardWriteScope` reads.
  const reservedMismatch = reservedChildId !== undefined && childId !== reservedChildId
  if (reservedMismatch) {
    log(
      `worktree: child=${childId ?? '?'} is not the reserved id ${reservedChildId} — `
      + 'the backend did not honor the reserved child id, so no intent could be claimed',
    )
  }
  const outcome = await awaitWorktree(window.worktreePromise)
  let final = outcome === undefined
    ? {
        ok: false,
        error: reservedMismatch
          ? 'the backend did not honor the reserved child id, so no worktree could be claimed (isolation skipped)'
          : 'no worktree was created (the child creation hook did not request one)',
      }
    : outcome
  if (outcome?.timedOut === true) {
    // The ceiling fired, but the creation may have answered in the same tick and
    // already recorded its checkout: that answer is the truth, so use it instead
    // of overwriting it with the timeout.
    const arrived = childWorktrees.get(String(childId ?? ''))
    if (arrived !== undefined) {
      final = { ok: true, worktree: arrived }
    } else {
      // Otherwise the RESULT is decided now; the creation is not cancelled (the
      // child may still reach its first turn). Superseding keeps a late checkout
      // from rewriting the `worktreeError` this result is about to carry.
      supersedeWorktreeIntent(childId, `the parent stopped waiting after ${WORKTREE_WAIT_MS}ms`)
    }
  }
  if (outcome === undefined && !reservedMismatch) {
    log(`worktree: child=${childId ?? '?'} asked for isolation but no attempt was made`)
  }
  // Re-applied AFTER the await: the child hook may have settled the outcome
  // before the lease was re-keyed onto the child id, and this is the call that
  // makes both paths agree (`applyWorktreeToLease` is idempotent).
  recordWorktree(childId, final)
  applyWorktreeToLease(reservation?.lease, final, reservation?.scopes)
  // An isolated writer's claim is only FINAL once the worktree exists (its lease
  // points at the checkout, not at the declared scopes), so its durable record is
  // written HERE, after the wait. The non-isolated case is recorded in the
  // child's `agent/created` hook, where the child's own Session is guaranteed.
  if (reservation !== undefined && kind === 'write') {
    const childSession = sessionOfChild(ctx, childId)
    if (childSession === undefined) {
      log(`lease: child=${childId ?? '?'} Session unavailable; its lease is NOT durable (a resume will be refused)`)
    } else {
      recordLeaseOnce(ctx, childSession, leaseRecordOf(reservation.lease), childId).catch((error) => {
        log(`lease: record FAILED for child=${childId ?? '?'} (creation unaffected): ${error?.message}`)
      })
    }
  }
  // Kept on the activation handle so a settlement that races the cleanup of the
  // per-child map still reports the worktree.
  try {
    startWorktrees.set(started, worktreeFieldsFromOutcome(final))
  } catch {
    /* a frozen activation handle is not a reason to fail the dispatch */
  }
  return started
}

/** The child session id of a `started` activation, as a string. */
function childIdOf(started) {
  return started?.childId === undefined || started.childId === null ? undefined : String(started.childId)
}

/**
 * Observe the `result` promise of a child that was started with `wait:false`.
 *
 * The activation promise rejects on an infrastructure fault (depth exhausted
 * while materializing, provider refusal after start). Nobody awaits it in the
 * detached contract, so it must be caught here: Node may escalate an unhandled
 * rejection, and the run registry should show the failure instead of "running"
 * forever. The child's answer still arrives as a message; this only observes.
 */
function watchDetachedResult(started, childId, name) {
  try {
    const result = started?.result
    if (result === null || result === undefined || typeof result.then !== 'function') return
    Promise.resolve(result).catch((error) => {
      try {
        log(`delegate: wait:false child ${name} (child=${childId ?? '?'}) result rejected: ${String(error?.message ?? error)}`)
        updateRun(childId, { status: 'error', endedAt: Date.now() })
      } catch {
        /* bookkeeping after a rejection must not throw either */
      }
    })
  } catch (error) {
    log(`delegate: wait:false result hook FAILED: ${error?.message}`)
  }
}

/**
 * The longest raw text the child left behind: its end message, then its last
 * assistant turn, then the activation result. `summary` is whitespace-collapsed
 * and capped, so a caller that must PARSE a format (the judge / synthesis JSON)
 * asks for this instead. Never throws.
 */
function pickRaw(view, outcome) {
  let best = ''
  try {
    const candidates = [
      textOf(outcome?.endInfo?.lastAssistantMessage),
      view?.lastAssistant,
      textOf(outcome?.result?.output),
      typeof outcome?.result?.diagnostic === 'string' ? outcome.result.diagnostic : '',
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > best.length) best = candidate
    }
  } catch {
    /* raw text is a convenience; never fail the result over it */
  }
  return best
}

/**
 * `41000` → `41,000`. Thousands separators without depending on ICU data being
 * present in this Electron runtime.
 */
function formatTokens(value) {
  const rounded = Math.max(0, Math.round(Number(value) || 0))
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * `0.0029` → `0.29`, `0.8` → `80`: a percentage with at most two decimals and no
 * trailing zeros, for logs and diagnostics.
 */
function formatPercent(ratio) {
  const value = Number(ratio) * 100
  if (!Number.isFinite(value)) return '?'
  return String(Number(value.toFixed(2)))
}

/**
 * The model window for one settled child, or 0 when unknown.
 *
 * The child's own `request/context` event is the authoritative source: it is the
 * window the RESOLVED request ran against (`{ provider, model, contextWindow }`),
 * and in this DSH the LLM catalog's `LlmModelInfo` carries no `contextWindow` at
 * all (`contextWindow` only lives on the per-request `context`/`LlmModelContext`),
 * so `listModels` cannot answer this question. It stays as a best-effort FALLBACK
 * for a custom catalog that does advertise one; a failure there is simply
 * "unknown". Never throws.
 */
async function contextWindowFor(ctx, view, route) {
  try {
    const fromEvent = Number(view?.contextWindow)
    if (Number.isFinite(fromEvent) && fromEvent > 0) return fromEvent
  } catch {
    /* fall through to the catalog fallback */
  }
  try {
    const cut = route.indexOf('/')
    if (cut <= 0 || cut >= route.length - 1) return 0
    const provider = route.slice(0, cut)
    const model = route.slice(cut + 1)
    let llm
    try {
      llm = ctx.get('llm')
    } catch {
      llm = undefined
    }
    if (llm === undefined || llm === null || typeof llm.listModels !== 'function') return 0
    // `modelsOf` caches per provider for 60 s, so a batch reads the catalog once.
    const models = await modelsOf(llm, provider)
    if (!Array.isArray(models)) return 0
    const info = models.find(entry => entry?.id === model)
    const fromCatalog = Number(info?.contextWindow)
    return Number.isFinite(fromCatalog) && fromCatalog > 0 ? fromCatalog : 0
  } catch (error) {
    log(`ctx warn: catalog fallback FAILED (skipped): ${error?.message}`)
    return 0
  }
}

/**
 * The context warning for one settled child, or undefined when there is nothing
 * to warn about.
 *
 * Occupancy is the child's LAST assistant turn (`inputTokens +
 * cacheReadTokens`) over the window its own resolved request ran against (the
 * `request/context` event; see {@link contextWindowFor}) — that sum is what its
 * next request would pay again, so it is the quantity that predicts compaction.
 * Both halves must be known: an unknown route or an unknown window yields NO
 * warning (a guessed denominator would produce a confidently wrong number), and
 * a child that never sent a request has neither.
 *
 * Every decision is logged once (`ctx warn: used=… window=… ratio=…% threshold=…%
 * -> warn|no`), so "did not warn" can always be told apart from "had no
 * denominator" without re-reading the child's log.
 *
 * Never throws.
 */
async function contextWarningFor(ctx, view, requestedModel) {
  try {
    const used = Number(view?.lastPromptTokens ?? 0)
    if (!Number.isFinite(used) || used <= 0) {
      log('ctx warn: no prompt usage in the child log -> no')
      return undefined
    }
    const reported = typeof view?.model === 'string' ? view.model : ''
    const requested = typeof requestedModel === 'string' ? requestedModel : ''
    const route = reported !== '' ? reported : requested
    if (route === '' || route === 'inherit') {
      log(`ctx warn: used=${used} route=unknown -> no (no provider-reported route)`)
      return undefined
    }

    const contextWindow = await contextWindowFor(ctx, view, route)
    // No denominator ⇒ no warning. Never invent one.
    if (!(Number.isFinite(contextWindow) && contextWindow > 0)) {
      log(`ctx warn: used=${used} window=unknown route=${route} -> no (no request/context contextWindow)`)
      return undefined
    }

    const ratio = used / contextWindow
    const threshold = contextWarnRatio()
    const warn = ratio >= threshold
    log(
      `ctx warn: used=${used} window=${contextWindow} ratio=${formatPercent(ratio)}% `
      + `threshold=${formatPercent(threshold)}% -> ${warn ? 'warn' : 'no'}`,
    )
    if (!warn) return undefined
    const percent = Math.max(1, Math.round(ratio * 100))
    return `该子代理已用到 ${percent}% 上下文（${formatTokens(used)}/${formatTokens(contextWindow)}）；`
      + '继续给它加活会触发压缩、质量下降，建议另起一个子代理'
  } catch (error) {
    log(`ctx warn FAILED (skipped): ${error?.message}`)
    return undefined
  }
}

/**
 * Wait for one started child and map its log onto the result contract.
 *
 * Never throws (an unreadable child becomes status "error"), so a batch can run
 * this for every task without one failure aborting the others.
 *
 * `raw: true` adds the full (uncollapsed) answer text — opt-in, because only a
 * caller that parses a structured answer needs it.
 *
 * `agent` (optional) is the calling Agent. The host admits ONLY its exact
 * identity as the ancestor authority, so it is the only way this function can
 * stop a child explicitly (parent abort, `timeoutAction=interrupt`); a caller
 * that passes none keeps the old detached behavior unchanged.
 */
async function settleChild(ctx, options) {
  const { started, childId, name, kind, budgetMs, signal, startedAt } = options
  // The calling Agent, when the caller can supply it: needed only to STOP the
  // child (an external child does not follow the parent abort signal).
  const agent = options.agent
  const timeoutAction = normalizeTimeoutAction(options.timeoutAction)
  // The model this child was explicitly asked to use, if any. Absent means
  // "inherit this session's model" — the runtime's own default.
  const requestedModel = typeof options.model === 'string' && options.model !== '' ? options.model : undefined
  const spent = () => Date.now() - startedAt
  try {
    // Hold the Session object now: a settled child may leave the store.
    let knownSession
    try {
      if (childId !== undefined) knownSession = ctx.get('sessions')?.get(childId)
    } catch (error) {
      log(`delegate: session pre-capture FAILED: ${error?.message}`)
    }

    // A LOCAL child cancel follows the parent signal; an EXTERNAL child that
    // already started does not, so the hook is the only explicit stop available
    // and `settle` fires it only on the abort path.
    const outcome = await settle(ctx, started, childId, budgetMs, signal, {
      onAbort: agent === undefined || childId === undefined
        ? undefined
        : () => requestInterrupt(ctx, agent, childId, 'parent session aborted'),
    })

    let view = emptyView()
    try {
      if (childId !== undefined) view = inspectChild(ctx, childId, knownSession)
    } catch (error) {
      log(`delegate: child inspection FAILED: ${error?.message}`)
    }

    const status = decideStatus(view, outcome)
    let summary = pickSummary(view, outcome, name, status, kind, budgetMs)
    // A wait cap is not a verdict on the child. The default detaches (the child
    // and its write lease stay), so the summary is what tells the caller not to
    // re-dispatch; `timeoutAction=interrupt` adds the explicit stop HERE, where
    // the caller's ancestor authority is known.
    if (status === 'timeout' && timeoutAction === 'interrupt' && childId !== undefined) {
      const stopped = requestInterrupt(ctx, agent, childId, `budget ${budgetMs}ms reached (timeoutAction=interrupt)`)
      summary = summarize(
        stopped.ok
          ? `${summary}; timeoutAction=interrupt: stop requested`
          : `${summary}; timeoutAction=interrupt FAILED (${stopped.code}): ${stopped.message}`,
      )
    }
    const elapsedMs = spent()
    // What to report as `model`: the explicit request, else the route the child
    // actually ran on (provider-reported), else the literal "inherit" — never a
    // guess about which model the parent happened to be using.
    const actualModel = view.model === '' ? undefined : view.model
    const reportedModel = requestedModel ?? actualModel ?? 'inherit'
    log(
      `delegate: settled via=${outcome.via} status=${status} child=${childId ?? '?'} model=${reportedModel} `
      + `elapsed=${elapsedMs}ms usage=${JSON.stringify(view.usage)} denials=${view.denials.length}`,
    )
    // Context pressure: a child that already fills the configured share of its
    // window is a compaction risk, so the caller is told BEFORE it hands that
    // same child more work. Isolated and awaitable — it never fails the result.
    let contextWarning
    try {
      contextWarning = await contextWarningFor(ctx, view, requestedModel)
    } catch (error) {
      log(`delegate: context warning FAILED: ${error?.message}`)
    }
    return {
      kind: 'activation',
      name,
      ...(childId === undefined ? {} : { child: childId }),
      status,
      summary,
      denials: view.denials,
      usage: view.usage,
      model: reportedModel,
      ...(contextWarning === undefined ? {} : { contextWarning }),
      // Tier 3: `worktree` when isolation succeeded, `worktreeError` when it did
      // not, neither when isolation was never requested for this child. The
      // per-activation copy wins over the by-child registry (which `subagent/end`
      // may already have cleaned).
      ...worktreeResultFields(childId),
      ...startWorktreeFields(started),
      elapsedMs,
      ...(options.raw === true ? { raw: pickRaw(view, outcome) } : {}),
    }
  } catch (error) {
    // Absolute backstop: a settled delegation never throws in wait mode,
    // whatever the services did.
    const message = String(error?.message ?? error)
    log(`delegate RESULT FAILED (kind=${kind}): ${message}`)
    return {
      kind: 'activation',
      name,
      ...(childId === undefined ? {} : { child: childId }),
      status: 'error',
      summary: summarize(`delegate could not read the child result: ${message}`),
      denials: [],
      usage: zeroUsage(),
      model: requestedModel ?? 'inherit',
      ...worktreeResultFields(childId),
      ...startWorktreeFields(started),
      elapsedMs: spent(),
    }
  } finally {
    // Release-path safety net: `subagent/end` is the primary release, but a
    // timeout leaves the child running (its lease is then correctly kept) and a
    // missed event must not wedge every later delegation. A lease whose child is
    // no longer live is dropped here; the rest are covered by the acquisition
    // sweep and the hard TTL.
    try {
      sweepWriteLeases(ctx)
    } catch (error) {
      log(`delegate: lease sweep FAILED: ${error?.message}`)
    }
  }
}

/**
 * Ask the host to stop one delegated child, under the exact live-ancestor
 * authority it requires. Never throws: each caller decides whether a failure is
 * reported to the model (cancel_subagent) or only logged (budget interrupt,
 * maxRuntimeMs, parent abort).
 *
 * The host call is synchronous and silently no-ops for a target that is not
 * resident, so `ok` means the request was ACCEPTED, never that the child is
 * gone.
 */
function requestInterrupt(ctx, agent, childId, reason) {
  try {
    if (childId === undefined || childId === null || String(childId) === '') {
      return { ok: false, code: 'NO_TARGET', message: 'no child id to stop' }
    }
    if (agent === undefined) return { ok: false, code: 'NO_AGENT', message: 'no calling agent' }
    const subagents = ctx.get('subagents')
    if (subagents === undefined || typeof subagents.interrupt !== 'function') {
      const message = subagents === undefined
        ? 'subagents service unavailable'
        : 'this host does not expose subagents.interrupt'
      log(`interrupt: child=${childId} SKIPPED (${reason}): ${message}`)
      return { ok: false, code: 'UNSUPPORTED', message }
    }
    subagents.interrupt(String(childId), { kind: 'ancestor', agent })
    log(`interrupt: child=${childId} (${reason})`)
    return { ok: true }
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'INTERRUPT_FAILED'
    const message = String(error?.message ?? error)
    log(`interrupt: child=${childId} FAILED (${reason}): ${code}: ${message}`)
    return { ok: false, code, message }
  }
}

/**
 * Arm the optional `maxRuntimeMs` cap on ONE child lifetime.
 *
 * Deliberately not part of `settle`: a `wait:false` child outlives the tool call
 * entirely and a `wait:true` call may detach on its budget, so neither
 * settlement path owns this timer. It is disarmed by the activation `result`
 * promise (which settles for local and external children alike) and, on the
 * wait path, by `delegate` right after the settlement. The timer is unref-ed so
 * a pending cap cannot keep the host process alive.
 */
function startRuntimeCap(ctx, agent, childId, label, maxRuntimeMs, started) {
  if (!(Number(maxRuntimeMs) > 0) || childId === undefined) return () => {}
  const timer = setTimeout(() => {
    log(`runtime cap: child=${childId} (${label}) exceeded maxRuntimeMs=${maxRuntimeMs}; interrupting`)
    requestInterrupt(ctx, agent, childId, `maxRuntimeMs=${maxRuntimeMs} exceeded`)
  }, Number(maxRuntimeMs))
  if (typeof timer?.unref === 'function') timer.unref()
  const stop = () => {
    try {
      clearTimeout(timer)
    } catch {
      /* a cleared timer is not an error */
    }
  }
  try {
    const result = started?.result
    if (result !== null && result !== undefined && typeof result.then === 'function') {
      Promise.resolve(result).then(stop, stop)
    }
  } catch (error) {
    log(`runtime cap: result hook FAILED: ${error?.message}`)
  }
  return stop
}

/**
 * Whether `childId` is a descendant of `parentId`, from what the plugin can
 * prove locally: the run registry (our own delegations, including `wait:false`
 * ones) and the durable `parentSession` chain (children the host `subagent`
 * tool created). The host re-checks the exact live ancestor before it
 * interrupts, so a false positive is harmless (UNAUTHORIZED) while a false
 * negative would silently strand a running writer.
 */
function isDescendantSession(ctx, parentId, childId) {
  try {
    if (parentId === undefined || childId === undefined) return false
    const self = String(parentId)
    const target = String(childId)
    const entry = runs.get(target)
    if (entry !== undefined && runInTree(entry, self)) return true
    let current = target
    for (let guard = 0; guard < 32; guard += 1) {
      const session = ctx.get('sessions')?.get?.(current)
      const header = session?.header
      if (header === undefined) return false
      const parent = header.parentSession
      if (parent === undefined) return false
      if (String(parent) === self) return true
      current = String(parent)
    }
    return false
  } catch {
    return false
  }
}

/** Whether one child still looks live: in `agents`, or a run row still running. */
function isLiveChild(ctx, childId) {
  try {
    const entry = runs.get(String(childId))
    if (entry !== undefined && entry.status === 'running') return true
    return ctx.get('agents')?.get?.(String(childId)) !== undefined
  } catch {
    return false
  }
}

const DEFAULT_CONCURRENCY = 4
const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 8
/** Caps the batch renderer so one wide batch cannot flood the parent's turn. */
const RENDER_LIMIT = 12

/** Coerce a batch concurrency into the supported range. */
function clampConcurrency(value) {
  const concurrency = Number(value)
  if (!Number.isFinite(concurrency)) return DEFAULT_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(concurrency)))
}

/** JSON schema of one `delegate` result; `delegate_many` reuses it per task. */
function activationResultProperties() {
  return {
    kind: { type: 'string', const: 'activation' },
    name: { type: 'string' },
    child: { type: 'string' },
    status: { type: 'string', enum: STATUSES },
    summary: { type: 'string' },
    denials: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          code: { type: 'string' },
        },
        required: ['tool', 'code'],
        additionalProperties: false,
      },
    },
    usage: {
      type: 'object',
      properties: {
        inputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
        totalTokens: { type: 'number' },
      },
      required: ['inputTokens', 'outputTokens', 'totalTokens'],
      additionalProperties: false,
    },
    // The model this delegation was sent to: "provider/model" when one was
    // requested, the provider-reported route when readable, else "inherit".
    model: { type: 'string' },
    // Tier 3 (worktree isolation). Present ONLY when `isolate:true` produced a
    // worktree; `worktreeError` is present ONLY when it could not be created, so
    // the two never appear together and neither appears for a normal delegation.
    worktree: {
      type: 'object',
      properties: {
        branch: { type: 'string' },
        path: { type: 'string' },
        baseCommit: { type: 'string' },
      },
      required: ['branch', 'path', 'baseCommit'],
      additionalProperties: false,
    },
    worktreeError: { type: 'string' },
    // Present ONLY when the child's last request already reached the configured
    // share of its model's context window; the prose carries the real numbers.
    contextWarning: { type: 'string' },
    // Present ONLY when the same task text was already delegated by this parent
    // inside the duplicate window: the earlier run's name.
    duplicateOf: { type: 'string' },
    elapsedMs: { type: 'number' },
  }
}

// ---------------------------------------------------------------------------
// Result rendering
//
// The rendered tool card is what the model and the human actually read, so it
// carries the route next to the status — and the failure reason, because a row
// whose reason never reached the card reads as "it just broke".
// ---------------------------------------------------------------------------

/** One-line cap for an already-collapsed summary inside a rendered card. */
const DISPLAY_TEXT_LIMIT = 200

/** The ` · model=…` suffix of one delegated result (nothing else is added). */
function describeRoute(value) {
  if (typeof value?.model !== 'string' || value.model === '') return ''
  return ` · model=${value.model}`
}

/**
 * The ` · wt=<branch>` suffix of one result row (Tier 3): the branch is exactly
 * what `git branch` shows, so the caller can inspect or merge the work by hand.
 */
function describeWorktreeBadge(value) {
  try {
    const branch = typeof value?.worktree?.branch === 'string' ? value.worktree.branch.trim() : ''
    return branch === '' ? '' : ` · wt=${branch}`
  } catch {
    return ''
  }
}

/** The failure line for a card body, or undefined when isolation worked/absent. */
function describeWorktreeError(value) {
  try {
    const error = typeof value?.worktreeError === 'string' ? value.worktreeError.trim() : ''
    if (error === '') return undefined
    return `worktree error: ${clipText(error, DISPLAY_TEXT_LIMIT)}`
  } catch {
    return undefined
  }
}

/**
 * Compose one summary out of a note and the child's own text.
 *
 * The note goes FIRST and is capped separately (NOTE_LIMIT), then the summary
 * gets whatever room is left under SUMMARY_LIMIT. The old order put the note at
 * the END, so a long answer truncated exactly the "isolate was ignored" /
 * "duplicate of …" notice the caller needs to act on.
 */
function composeNoteSummary(summary, note) {
  const base = summarize(summary)
  const clippedNote = clipText(note, NOTE_LIMIT)
  if (clippedNote === '') return base
  if (base === '') return clippedNote
  const room = Math.max(0, SUMMARY_LIMIT - clippedNote.length - 3)
  const clippedBase = base.length > room
    ? `${base.slice(0, Math.max(0, room - 1))}…`
    : base
  return clippedBase === '' ? clippedNote : `${clippedNote} · ${clippedBase}`
}

/**
 * Prepend a note to a result's summary, so a caller is told why an option was
 * ignored instead of being refused. A result without a summary gets the note.
 */
function withSummaryNote(result, note) {
  if (note === undefined || result === null || typeof result !== 'object') return result
  try {
    const summary = typeof result.summary === 'string' ? result.summary : ''
    return { ...result, summary: composeNoteSummary(summary, note) }
  } catch {
    return result
  }
}

/**
 * Append the "isolate was ignored" note to a result's summary, so a
 * reader/verifier that asked for `isolate` is told why nothing was created
 * instead of being refused.
 */
function withIsolateNote(result, note) {
  return withSummaryNote(result, note)
}

/** Apply several summary notes in order ({@link withSummaryNote}). */
function withNotes(result, notes) {
  let row = result
  for (const note of notes ?? []) row = withSummaryNote(row, note)
  return row
}

/**
 * The ` ⚠ ctx 82%` suffix of one result row, or '' when there is no warning.
 *
 * The percentage is read back out of `contextWarning` — the same generator wrote
 * both — so the result contract keeps ONE new field instead of a redundant
 * number, and a warning in an unexpected shape still renders as `⚠ ctx`.
 */
function describeContextBadge(value) {
  try {
    const warning = typeof value?.contextWarning === 'string' ? value.contextWarning : ''
    if (warning === '') return ''
    const match = /([0-9]+)%/.exec(warning)
    return match === null ? ' ⚠ ctx' : ` ⚠ ctx ${match[1]}%`
  } catch {
    return ''
  }
}

/** The full warning prose for a card body, or undefined when absent. */
function describeContextWarning(value) {
  const warning = typeof value?.contextWarning === 'string' ? value.contextWarning.trim() : ''
  return warning === '' ? undefined : clipText(warning, DISPLAY_TEXT_LIMIT)
}

/** `denials: tool/CODE, …` for a card, or undefined when there are none. */
function describeDenials(denials) {
  if (!Array.isArray(denials) || denials.length === 0) return undefined
  return `denials: ${denials.map(entry => `${entry?.tool ?? '?'}/${entry?.code ?? '?'}`).join(', ')}`
}

/** Projection: inbound agent messages plus context pressure for one session. */
const edgesProjection = {
  key: 'subagentEdges',
  stateVersion: 1,
  stateSchema: LENIENT,
  // No `context` key here: a projection's value must be lossless JSON, and an
  // explicitly-undefined property fails the "lossless JSON" check when the
  // session summary is forwarded. The key appears only once it has a number.
  init: () => ({ incoming: [] }),
  apply: (state, event) => {
    // Context pressure, folded here because the built-in `contextPressure`
    // projection is excluded from session summaries — a child that is not open has
    // no client-visible value otherwise. A prompt's real size is what the next
    // request pays: uncached input + cache reads.
    if (event?.type === 'assistant/message' && event.data?.usage !== undefined) {
      const usage = event.data.usage
      const pressureTokens = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0)
      if (pressureTokens > 0) {
        return { ...state, context: { pressureTokens } }
      }
      return state
    }
    if (event?.type !== 'agent/inbox/spliced') return state
    const inserted = event.data?.inserted ?? []
    const added = []
    for (const message of inserted) {
      const source = message?.source
      if (source?.kind === 'agent-message' && typeof source.senderSessionId === 'string') {
        added.push({ from: source.senderSessionId, at: event.time })
      }
    }
    if (added.length === 0) return state
    return { ...state, incoming: [...state.incoming, ...added] }
  },
  wire: {
    viewSchema: LENIENT,
    view: state => state,
    summary: true,
  },
}

// ---------------------------------------------------------------------------
// Judge kernel — arbitration between two conflicting child conclusions
//
// Two children answering the same question can disagree, and re-investigating
// the problem is the expensive way to find out who is right. This kernel spawns
// ONE read-only child whose only job is to open the `path:line` evidence each
// side supplied and report which set actually holds. It is forbidden to
// re-survey the codebase, and it must answer `inconclusive` when the evidence
// does not decide the question. The child runs with kind="read" (reader
// whitelist + read-only sandbox) through the SAME start/settle/privilege
// machinery as `delegate`; only the prompt and the answer parsing are new.
//
// This is INTERNAL (`runJudge`): there is deliberately no model-visible `judge`
// tool. The only caller is `delegate_many`'s reconciliation step, which already
// knows which pairs really conflict, so the model never pays for a judge call
// it has to orchestrate itself.
// ---------------------------------------------------------------------------

const DEFAULT_JUDGE_BUDGET_MS = 60000
/** Caps evidence paths per side so one side cannot flood the judge's prompt. */
const JUDGE_EVIDENCE_LIMIT = 40
/** Caps `checked` in the result for the same reason. */
const JUDGE_CHECKED_LIMIT = 50
/** Cap on the prose fallback copied into `reason` when JSON parsing fails. */
const JUDGE_RAW_LIMIT = 200
/** Cap on a parsed `reason`. */
const JUDGE_REASON_LIMIT = 400
/** Every verdict the judge kernel may return. */
const JUDGE_VERDICTS = ['a', 'b', 'inconclusive']
/** Every status the judge kernel may return (narrower than delegate's). */
const JUDGE_STATUSES = ['ok', 'timeout', 'error', 'denied']
/** Cap on JSON candidate starts tried in one child answer. */
const JUDGE_JSON_ATTEMPTS = 20
/** Monotonic suffix so two judges started in the same millisecond never share a name. */
let judgeSeq = 0

/** One line, whitespace-collapsed, control characters stripped, length-capped. Never throws. */
function clipText(value, limit) {
  const flat = stripControlChars(value).replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(0, limit - 1))}…`
}

/** Normalize one side of the dispute: claim plus bounded, de-duplicated evidence. */
function normalizeSide(raw) {
  const claim = typeof raw?.claim === 'string' ? raw.claim.trim() : ''
  const evidence = []
  if (Array.isArray(raw?.evidence)) {
    for (const entry of raw.evidence) {
      if (typeof entry !== 'string') continue
      const path = entry.trim()
      if (path === '' || evidence.includes(path)) continue
      evidence.push(path)
      if (evidence.length >= JUDGE_EVIDENCE_LIMIT) break
    }
  }
  return { claim, evidence }
}

/**
 * The balanced `{...}` object starting at `start`, or undefined when the text
 * ends first. Braces inside quoted strings are ignored (with escape handling),
 * so a reason that mentions `{` cannot cut the candidate short.
 */
function balancedObjectAt(source, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return undefined
}

/** Keys that identify the ANSWER object rather than a `{}` quoted in prose. */
const JSON_ANSWER_KEYS = ['verdict', 'merged', 'findings', 'consensus']

/**
 * The `{...}` in `text` that parses as JSON and looks like the answer.
 *
 * Tolerant on purpose: a child may wrap the answer in prose or a Markdown
 * fence, so every `{` is tried in turn (bounded) and a malformed candidate is
 * skipped rather than treated as fatal. Two passes over the SAME bounded set:
 * the first candidate carrying an answer key (verdict / merged / findings /
 * consensus) wins; only when none does is the first parseable object used.
 * Without that preference, a child that quotes `{}` while explaining its format
 * would hand the judge an empty object and the batch an empty `merged`.
 */
function extractJsonObject(text) {
  const source = String(text ?? '')
  const parsedCandidates = []
  let from = source.indexOf('{')
  let attempts = 0
  while (from >= 0 && attempts < JUDGE_JSON_ATTEMPTS) {
    attempts += 1
    const candidate = balancedObjectAt(source, from)
    if (candidate !== undefined) {
      try {
        parsedCandidates.push({ candidate, parsed: JSON.parse(candidate) })
      } catch {
        /* not the answer object; try the next '{' */
      }
    }
    from = source.indexOf('{', from + 1)
  }
  if (parsedCandidates.length === 0) return undefined
  const preferred = parsedCandidates.find(({ parsed }) => (
    parsed !== null
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && JSON_ANSWER_KEYS.some(key => Object.hasOwn(parsed, key))
  ))
  return (preferred ?? parsedCandidates[0]).candidate
}

/**
 * Parse the judge's answer leniently. A missing / malformed / unparsable answer
 * is NOT an error: it becomes `inconclusive`, with the (clipped) raw text as the
 * reason. An out-of-contract verdict is also coerced to `inconclusive`.
 */
function parseJudgeAnswer(text) {
  const raw = clipText(text, JUDGE_RAW_LIMIT)
  const fallback = {
    verdict: 'inconclusive',
    checked: [],
    parsed: false,
    reason: raw === '' ? 'judge 没有输出任何内容' : raw,
  }
  const json = extractJsonObject(text)
  if (json === undefined) return fallback
  let data
  try {
    data = JSON.parse(json)
  } catch {
    return fallback
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return fallback

  const checked = []
  if (Array.isArray(data.checked)) {
    for (const entry of data.checked) {
      if (typeof entry !== 'string') continue
      const path = entry.trim()
      if (path === '') continue
      checked.push(path)
      if (checked.length >= JUDGE_CHECKED_LIMIT) break
    }
  }
  const verdictRaw = typeof data.verdict === 'string' ? data.verdict.trim() : ''
  // Strict on the contract: anything but the exact three tokens is inconclusive.
  const verdict = JUDGE_VERDICTS.includes(verdictRaw) ? verdictRaw : 'inconclusive'
  const reasonText = typeof data.reason === 'string' ? clipText(data.reason, JUDGE_REASON_LIMIT) : ''
  const reason = reasonText !== ''
    ? reasonText
    : verdict === 'inconclusive'
      ? 'judge 认为证据不足以判断，但没有给出理由'
      : 'judge 没有给出理由'
  return { verdict, checked, parsed: true, reason }
}

/**
 * The judge prompt. Three hard rules: open every supplied path and check it,
 * answer with JSON only, and say `inconclusive` when the evidence does not
 * decide. The judge is explicitly forbidden to investigate on its own.
 */
function judgePrompt(question, sideA, sideB, budgetMs) {
  const evidenceOf = side => (side.evidence.length === 0
    ? '（未提供）'
    : side.evidence.map(path => `- ${path}`).join('\n'))
  return [
    '你是分歧裁判（只读）。唯一的任务是核对下面两套证据路径是否成立，',
    '不要重新调查问题，不要补充自己的判断，也不要给出建议。',
    '',
    `问题：${question}`,
    '',
    `甲方案结论：${sideA.claim === '' ? '（未提供）' : sideA.claim}`,
    '甲方案证据：',
    evidenceOf(sideA),
    '',
    `乙方案结论：${sideB.claim === '' ? '（未提供）' : sideB.claim}`,
    '乙方案证据：',
    evidenceOf(sideB),
    '',
    '规则（全部必须遵守）：',
    '1. 逐条用 read 打开上面列出的每个 path:line，核对文件内容是否确实支持对应结论；',
    '   打不开、行号越界、内容不符，都如实算作该证据不成立。不要用 grep/glob 去别处',
    '   补证据，也不要自己另找来源。',
    '2. 只输出一个 JSON 对象，不要散文、不要前后缀、不要 Markdown 代码块，形如',
    '   {"verdict":"a|b|inconclusive","reason":"一句话理由","checked":["path:line", ...]}；',
    '   verdict 只能是 a、b、inconclusive 之一，checked 只列你真正打开过的证据。',
    '3. 证据不足以判断（关键证据打不开，或两边证据都不完全支持各自结论）就输出',
    '   "inconclusive"，不要猜，也不要用常识替证据。',
    '',
    '边界：你只有只读工具，不要修改任何文件，不要委派新的子代理。',
    `预算约 ${budgetMs}ms，请直接开始核对。`,
  ].join('\n')
}

/** Build one judge result with every field normalized; never throws. */
function verdictResult(fields) {
  const status = JUDGE_STATUSES.includes(fields?.status) ? fields.status : 'error'
  const verdict = JUDGE_VERDICTS.includes(fields?.verdict) ? fields.verdict : 'inconclusive'
  let checked = []
  try {
    if (Array.isArray(fields?.checked)) checked = fields.checked.filter(entry => typeof entry === 'string')
  } catch {
    checked = []
  }
  const elapsed = Number(fields?.elapsedMs)
  return {
    kind: 'verdict',
    verdict,
    reason: clipText(fields?.reason ?? '', JUDGE_REASON_LIMIT),
    checked,
    status,
    ...(typeof fields?.child === 'string' && fields.child !== '' ? { child: fields.child } : {}),
    usage: fields?.usage ?? zeroUsage(),
    elapsedMs: Number.isFinite(elapsed) ? elapsed : 0,
  }
}

/**
 * The judge kernel. Never throws: every failure path returns a `kind:"verdict"`
 * object with verdict="inconclusive".
 *
 * `parent` is the calling agent; the runtime context travels in `options.ctx`
 * (this is a plain function, not a tool handler), and `options.signal` is the
 * caller's abort signal. Everything below the argument check is the exact
 * pipeline the retired `judge` tool used: preflight → privilege → serialized
 * start → settle → lenient answer parse.
 */
async function runJudge(parent, options) {
  const startedAt = Date.now()
  const spent = () => Date.now() - startedAt
  const ctx = options?.ctx
  const signal = options?.signal
  const budgetMs = options?.budgetMs === undefined
    ? DEFAULT_JUDGE_BUDGET_MS
    : clampBudget(options.budgetMs)
  try {
    const question = typeof options?.question === 'string' ? options.question.trim() : ''
    const sideA = normalizeSide(options?.a)
    const sideB = normalizeSide(options?.b)
    /** A verdict result that never started a child. Never throws. */
    const fail = (status, reason) => {
      log(`judge: ${status} — ${reason}`)
      return verdictResult({
        verdict: 'inconclusive',
        reason,
        checked: [],
        status,
        elapsedMs: spent(),
      })
    }

    if (ctx === undefined) return fail('error', 'judge 缺少运行上下文')
    if (question === '') return fail('error', 'judge 需要非空 question')
    if (sideA.claim === '' && sideB.claim === '') {
      return fail('error', 'judge 需要 a.claim 或 b.claim 至少一个非空')
    }
    // With no evidence path at all the judge is guaranteed to answer
    // inconclusive, so say so up front instead of paying for a child.
    if (sideA.evidence.length === 0 && sideB.evidence.length === 0) {
      return fail('ok', '双方都没有提供证据路径（a.evidence / b.evidence 均空），裁判没有可核对的内容，判 inconclusive')
    }

    let pre
    try {
      pre = preflight(ctx, { agent: parent })
    } catch (error) {
      return fail('error', `judge 无法运行：${String(error?.message ?? error)}`)
    }

    // The judge is always a reader; privilegeCheck still runs so a
    // (theoretical) future non-reader parent cannot launder anything.
    const privilege = privilegeCheck(pre.parentId, 'read', pre.parent)
    if (!privilege.allowed) return fail('denied', privilege.message)

    judgeSeq += 1
    const judgeName = `judge-${Date.now().toString(36).slice(-5)}-${judgeSeq.toString(36)}`
    let started
    try {
      started = await startChild(ctx, {
        parentId: pre.parentId,
        parent: pre.parent,
        subagents: pre.subagents,
        providerName: pre.providerName,
        task: judgePrompt(question, sideA, sideB, budgetMs),
        kind: 'read',
        name: judgeName,
        signal,
      })
    } catch (error) {
      return fail('error', `judge 无法启动裁判子代理：${String(error?.message ?? error)}`)
    }
    const childId = childIdOf(started)
    log(`judge: started ${judgeName} (child=${childId ?? '?'}, budget=${budgetMs}ms)`)
    // The judge is a real child: register it so the topology sidebar shows it instead of leaving
    // an invisible run (and never letting it sit at "running").
    registerRun(ctx, {
      childId,
      name: judgeName,
      parentId: pre.parentId,
      rootId: runRootOf(ctx, pre.parent?.session?.header, pre.parentId),
      model: 'inherit',
      startedAt,
      kind: 'read',
    })
    const withChild = childId === undefined ? {} : { child: childId }

    // Same settlement machinery as `delegate`, asking for the raw answer
    // because the judge's output has to be parsed, not just summarized.
    const settled = await settleChild(ctx, {
      started,
      childId,
      name: judgeName,
      kind: 'read',
      budgetMs,
      signal,
      startedAt,
      raw: true,
    })
    const usage = settled?.usage ?? zeroUsage()
    const elapsedMs = Number(settled?.elapsedMs)
    const childStatus = String(settled?.status ?? 'error')
    const childReason = typeof settled?.summary === 'string' ? settled.summary : ''
    updateRun(childId, {
      status: childStatus,
      endedAt: Date.now(),
      tokens: Number(usage.totalTokens ?? 0) || 0,
      ...(typeof settled?.model === 'string' && settled.model !== '' ? { model: settled.model } : {}),
    })

    if (childStatus === 'timeout') {
      return verdictResult({
        verdict: 'inconclusive',
        reason: childReason === '' ? '裁判子代理超出预算仍未给出结论' : childReason,
        checked: [],
        status: 'timeout',
        ...withChild,
        usage,
        elapsedMs,
      })
    }
    if (childStatus === 'denied') {
      return verdictResult({
        verdict: 'inconclusive',
        reason: childReason === '' ? '裁判子代理被沙箱拒绝' : childReason,
        checked: [],
        status: 'denied',
        ...withChild,
        usage,
        elapsedMs,
      })
    }
    if (childStatus !== 'ok' && childStatus !== 'partial') {
      return verdictResult({
        verdict: 'inconclusive',
        reason: childReason === '' ? `裁判子代理以 ${childStatus} 结束` : childReason,
        checked: [],
        status: 'error',
        ...withChild,
        usage,
        elapsedMs,
      })
    }

    const rawAnswer = typeof settled?.raw === 'string' && settled.raw !== ''
      ? settled.raw
      : childReason
    const answer = parseJudgeAnswer(rawAnswer)
    log(
      `judge: child=${childId ?? '?'} verdict=${answer.verdict} parsed=${String(answer.parsed)} `
      + `checked=${answer.checked.length} elapsed=${Number.isFinite(elapsedMs) ? elapsedMs : spent()}ms`,
    )
    return verdictResult({
      verdict: answer.verdict,
      reason: answer.reason,
      checked: answer.checked,
      status: 'ok',
      ...withChild,
      usage,
      elapsedMs,
    })
  } catch (error) {
    // Absolute backstop: the judge kernel never throws an uncaught error.
    const message = String(error?.message ?? error)
    log(`judge RESULT FAILED: ${message}`)
    try {
      return verdictResult({
        verdict: 'inconclusive',
        reason: `judge 内部错误：${message}`,
        checked: [],
        status: 'error',
        elapsedMs: spent(),
      })
    } catch {
      return {
        kind: 'verdict',
        verdict: 'inconclusive',
        reason: 'judge 内部错误',
        checked: [],
        status: 'error',
        usage: zeroUsage(),
        elapsedMs: spent(),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `delegate_many` reconciliation (`reconcile: true`)
//
// One batch usually answers ONE overall question through several children. When
// those children disagree, the parent used to have to orchestrate a third call
// (the retired `judge` tool) itself. The batch does it internally instead:
//
//   1. wait for every task to settle (already the case here)
//   2. only when at least two results are usable, start ONE read-only synthesis
//      child that merges the answer texts and reports REAL conflicts only
//   3. for at most the first two conflicts, run the judge kernel on the two
//      summaries and the evidence paths those results already carry
//
// Spend protection is absolute: a failed synthesis or a failed judge only leaves
// `merged: null` / a verdict="inconclusive" row behind, never a failed batch.
// ---------------------------------------------------------------------------

/** Statuses whose answer text may enter the synthesis prompt. */
const RECONCILE_USABLE = new Set(['ok', 'partial'])
/** Caps how many conflict pairs are judged (every judge is one more child). */
const RECONCILE_MAX_CONFLICTS = 2
/** Cap on the synthesis child's own wait, so reconcile cannot stall a batch. */
const RECONCILE_BUDGET_MS = 60000
/** Per-result cap on the answer text pasted into the synthesis prompt. */
const RECONCILE_SUMMARY_LIMIT = 1500
/** Cap on the merged conclusion kept in the result. */
const RECONCILE_MERGED_LIMIT = 2000
/** Cap on one conflict's `reason`. */
const RECONCILE_REASON_LIMIT = 300
/** Cap on evidence paths per side handed to the judge. */
const RECONCILE_EVIDENCE_LIMIT = 8
/** Hard cap on findings per batch: the synthesis contract says "at most 8". */
const RECONCILE_FINDINGS_MAX = 8
/** Cap on one finding's `claim`. */
const RECONCILE_CLAIM_LIMIT = 300
/** Cap on evidence paths per finding. */
const RECONCILE_FINDING_EVIDENCE_LIMIT = 8

/** Trim and cap raw text WITHOUT collapsing its whitespace. Never throws. */
function capText(value, limit) {
  const text = String(value ?? '').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * The synthesis prompt: both jobs, the exact JSON contract, and the one rule
 * that decides whether a conflict is real (contradiction ≠ wording difference).
 */
function reconcilePrompt(question, sides) {
  const blocks = sides.map(side => [
    `结果 #${side.index}（${side.name}，status=${side.status}）：`,
    side.summary === '' ? '（空）' : side.summary,
  ].join('\n'))
  return [
    '你是批量任务结果的合成者（只读）。下面同一次批量调用里，多个子代理各自回答了同一个总问题。',
    '你只做三件事：把它们的结论合并成一段话；把可复用的事实抽成 findings；找出真正互相矛盾的结论对。',
    '',
    `总问题：${question}`,
    '',
    '各条结果（编号就是结果下标，冲突对用这些下标）：',
    ...blocks,
    '',
    '规则（全部必须遵守）：',
    '1. merged：用一段话给出合并后的结论。只依据上面的结果内容，不要自己另做调查，',
    '   不要补充新事实；互相补充就合并，真有冲突就指出冲突在哪、哪一方说得更足。',
    '2. findings：把各条结果里值得直接复用的事实抽成条目，最多 8 条，超过 8 条就只留最确定的。',
    '   每条 claim 只用一句话，必须是上面结果里已经得出的结论，不要自己另做调查、不要补充新事实。',
    '   evidence 只填上面结果中明确出现过的 `path:line`：原样照抄，不要编造，不要改写路径，',
    '   也不要把 path 补成完整路径；某条结论在结果里没有给出路径时就填空数组 []，不要凑。',
    '3. conflicts：只有两条结论真的互相矛盾（对同一事实给出互斥的答案）才算 conflict。',
    '   措辞差异、详略不同、侧重点不同都不算，不要为了凑数而报冲突；没有真矛盾就输出空数组。',
    '4. 只输出一个 JSON 对象，不要散文、不要前后缀、不要 Markdown 代码块，形如',
    '   {"merged":"合并后的一段结论","findings":[{"claim":"一句结论","evidence":["path:line"]}],'
      + '"conflicts":[{"a":0,"b":1,"reason":"一句话说明矛盾在哪"}]}',
    '   a、b 是上面结果的下标且 a < b；reason 一句话，说明两条结论在哪一点上互斥。',
    '',
    '边界：你只有只读工具，不要修改任何文件，不要委派新的子代理。',
  ].join('\n')
}

/**
 * Parse the synthesis answer leniently: the first `{...}` that parses as JSON
 * wins; anything missing or malformed yields `merged: null`, no findings and no
 * conflicts. Findings and conflicts are INDEPENDENT of one another, so a bad
 * `findings` value can never cost the batch its `merged` text.
 * Bad input must never fail the batch, so nothing here throws.
 */
function parseReconcileAnswer(text) {
  const empty = { merged: null, findings: [], conflicts: [] }
  const json = extractJsonObject(text)
  if (json === undefined) return empty
  let data
  try {
    data = JSON.parse(json)
  } catch {
    return empty
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return empty

  const merged = typeof data.merged === 'string' && data.merged.trim() !== ''
    ? capText(data.merged, RECONCILE_MERGED_LIMIT)
    : null

  // Findings: claim is mandatory (a finding without a claim is noise); evidence
  // is optional and only ever COPIED from the answer, never synthesized here.
  const findings = []
  if (Array.isArray(data.findings)) {
    for (const entry of data.findings) {
      if (findings.length >= RECONCILE_FINDINGS_MAX) break
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const claim = typeof entry.claim === 'string' ? clipText(entry.claim, RECONCILE_CLAIM_LIMIT) : ''
      if (claim === '') continue
      const evidence = []
      if (Array.isArray(entry.evidence)) {
        for (const item of entry.evidence) {
          if (typeof item !== 'string') continue
          const path = item.trim()
          if (path === '' || evidence.includes(path)) continue
          evidence.push(path)
          if (evidence.length >= RECONCILE_FINDING_EVIDENCE_LIMIT) break
        }
      }
      findings.push({ claim, evidence })
    }
  }

  const conflicts = []
  if (Array.isArray(data.conflicts)) {
    for (const entry of data.conflicts) {
      if (conflicts.length >= RECONCILE_MAX_CONFLICTS) break
      if (entry === null || typeof entry !== 'object') continue
      const a = typeof entry.a === 'number' ? entry.a : Number.NaN
      const b = typeof entry.b === 'number' ? entry.b : Number.NaN
      // Only genuine pairs of distinct, non-negative integer indices count.
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue
      if (a === b || a < 0 || b < 0) continue
      if (conflicts.some(existing => (existing.a === a && existing.b === b) || (existing.a === b && existing.b === a))) continue
      const reason = typeof entry.reason === 'string' ? clipText(entry.reason, RECONCILE_REASON_LIMIT) : ''
      conflicts.push({ a, b, reason })
    }
  }
  return { merged, findings, conflicts }
}

/**
 * Evidence paths a settled result already carries, for the judge prompt.
 * The batch contract has no `evidence` field, so the fallback is to lift any
 * `path:line` tokens out of the summary; absent evidence is a legal empty list.
 */
function evidenceOfResult(result) {
  const found = []
  const push = (entry) => {
    if (found.length >= RECONCILE_EVIDENCE_LIMIT) return
    if (typeof entry !== 'string') return
    const path = entry.trim()
    if (path === '' || found.includes(path)) return
    found.push(path)
  }
  try {
    if (Array.isArray(result?.evidence)) for (const entry of result.evidence) push(entry)
    const summary = typeof result?.summary === 'string' ? result.summary : ''
    const matcher = /[^\s()（）"'`，。；、]+:[0-9]+(?:-[0-9]+)?/g
    for (const match of summary.matchAll(matcher)) push(match[0])
  } catch {
    /* evidence is a convenience; never fail a result over it */
  }
  return found.slice(0, RECONCILE_EVIDENCE_LIMIT)
}

/**
 * Merge one finished batch and arbitrate its real conflicts.
 *
 * Runs strictly after every task settled, so it cannot race the worker pool. It
 * reuses `startChild` (kind slot, privilege, write-lease admission) and
 * `settleChild` for the synthesis child, and the judge kernel for conflicts.
 * Returns `{ merged, findings, conflicts }`; it never throws.
 */
async function reconcileBatch(ctx, options) {
  const { parent, parentId, subagents, providerName, results, question, deadline, signal } = options
  const empty = { merged: null, findings: [], conflicts: [] }
  try {
    /** Usable answers, by their batch index. */
    const usable = new Map()
    for (const result of results) {
      if (RECONCILE_USABLE.has(String(result?.status)) === false) continue
      const index = Number(result?.index)
      if (!Number.isInteger(index) || usable.has(index)) continue
      usable.set(index, {
        index,
        name: String(result?.name ?? '?'),
        status: String(result?.status ?? '?'),
        summary: capText(result?.summary, RECONCILE_SUMMARY_LIMIT),
        result,
      })
    }
    const sides = [...usable.values()].sort((left, right) => left.index - right.index)

    // Spend protection #1: fewer than two usable answers means there is nothing
    // to merge and nothing to disagree with.
    if (sides.length < 2) {
      log(`reconcile SKIPPED: ${sides.length} usable result(s) < 2`)
      return empty
    }

    // Spend protection #2: reconcile never outlives the batch's own budget.
    const remaining = () => (deadline === undefined ? RECONCILE_BUDGET_MS : deadline - Date.now())
    if (remaining() < MIN_BUDGET_MS) {
      log(`reconcile SKIPPED: batch budget exhausted (${remaining()}ms left)`)
      return empty
    }

    const synthesisStarted = Date.now()
    const synthesisName = `reconcile-${Date.now().toString(36).slice(-6)}`
    let started
    try {
      started = await startChild(ctx, {
        parentId,
        parent,
        subagents,
        providerName,
        task: reconcilePrompt(question, sides),
        kind: 'read',
        name: synthesisName,
        signal,
      })
    } catch (error) {
      log(`reconcile: synthesis start FAILED: ${String(error?.message ?? error)}`)
      return empty
    }

    const childId = childIdOf(started)
    log(`reconcile: started ${synthesisName} (child=${childId ?? '?'}, ${sides.length} usable result(s))`)
    // A synthesis child is a real child too: register it so the topology sidebar
    // shows it (and its tokens) instead of only tracking delegate rows.
    registerRun(ctx, {
      childId,
      name: synthesisName,
      parentId,
      rootId: runRootOf(ctx, parent?.session?.header, parentId),
      model: 'inherit',
      startedAt: synthesisStarted,
      kind: 'read',
    })
    const settled = await settleChild(ctx, {
      started,
      childId,
      name: synthesisName,
      kind: 'read',
      budgetMs: Math.min(RECONCILE_BUDGET_MS, Math.max(MIN_BUDGET_MS, remaining())),
      signal,
      startedAt: synthesisStarted,
      raw: true,
    })

    const synthStatus = String(settled?.status ?? 'error')
    updateRun(childId, {
      status: synthStatus,
      endedAt: Date.now(),
      tokens: Number(settled?.usage?.totalTokens ?? 0) || 0,
      ...(typeof settled?.model === 'string' && settled.model !== '' ? { model: settled.model } : {}),
    })
    if (synthStatus !== 'ok' && synthStatus !== 'partial') {
      log(`reconcile: synthesis ended ${synthStatus}; merged left null`)
      return empty
    }

    const rawAnswer = typeof settled?.raw === 'string' && settled.raw !== ''
      ? settled.raw
      : (typeof settled?.summary === 'string' ? settled.summary : '')
    const parsed = parseReconcileAnswer(rawAnswer)
    log(
      `reconcile: synthesis status=${synthStatus} merged=${parsed.merged === null ? 'null' : `${parsed.merged.length} chars`} `
      + `findings=${parsed.findings.length} conflicts=${parsed.conflicts.length}`,
    )

    // At most RECONCILE_MAX_CONFLICTS (already capped while parsing) judged,
    // each one a fresh read-only child with its own self-contained brief.
    const conflicts = []
    for (const pair of parsed.conflicts) {
      const sideA = usable.get(pair.a)
      const sideB = usable.get(pair.b)
      if (sideA === undefined || sideB === undefined) {
        log(`reconcile: conflict ${pair.a}/${pair.b} does not name two usable results — dropped`)
        continue
      }
      let verdict = 'inconclusive'
      let verdictReason = ''
      const judgeBudget = Math.min(DEFAULT_JUDGE_BUDGET_MS, remaining())
      if (judgeBudget < MIN_BUDGET_MS) {
        verdictReason = '批量预算已用尽，未自动裁决这条冲突'
        log(`reconcile: judge SKIPPED for ${sideA.index}/${sideB.index} (${judgeBudget}ms left)`)
      } else {
        const judged = await runJudge(parent, {
          ctx,
          question,
          a: { claim: sideA.summary, evidence: evidenceOfResult(sideA.result) },
          b: { claim: sideB.summary, evidence: evidenceOfResult(sideB.result) },
          budgetMs: judgeBudget,
          signal,
        })
        verdict = judged.verdict
        verdictReason = judged.reason
      }
      conflicts.push({
        a: sideA.index,
        b: sideB.index,
        reason: pair.reason,
        verdict: JUDGE_VERDICTS.includes(verdict) ? verdict : 'inconclusive',
        verdictReason: clipText(verdictReason, JUDGE_REASON_LIMIT),
      })
    }

    return { merged: parsed.merged, findings: parsed.findings, conflicts }
  } catch (error) {
    // Absolute backstop: reconciliation never fails the batch.
    log(`reconcile FAILED (merged left null): ${String(error?.message ?? error)}`)
    return empty
  }
}

// ---------------------------------------------------------------------------
// 子代理管理：强制命名 / 运行登记表 / 结果落盘 / 重复检测 / 会话软隐藏
//
// Five costs of a long delegation session motivated this block:
//   - `list_agents()` returns every child at full cost (3-5K tokens once the tree
//     is large), so the topology needs a cheap, filterable text view;
//   - most children end up as `agent-N`, which nobody can remember;
//   - a result that arrived once is gone once its notice scrolled away;
//   - the same task is sometimes dispatched twice without anyone noticing;
//   - old child sessions pile up in the list forever.
//
// Everything here OBSERVES the existing pipeline (start → settle →
// `subagent/end`) and only ADDS bookkeeping; nothing changes how a child is
// created, trimmed, judged, leased or isolated. Every entry point is wrapped in
// try/catch: bookkeeping must never fail a tool call. P0-3 / P1-6 state is
// in-memory on purpose — a plugin reload empties it and the report then says
// "未知" instead of guessing.
// ---------------------------------------------------------------------------

/** Characters of a task used to derive a child name when `name` is omitted. */
const NAME_PREFIX_CHARS = 12

/** How a caller-supplied child name may look: bounded, no control characters. */
const CHILD_NAME_PATTERN = /^[\p{L}\p{N}._-]{1,64}$/u

/**
 * Normalize one caller-supplied child name.
 *
 * Returns the trimmed name when it matches CHILD_NAME_PATTERN (Unicode letters
 * and digits are allowed; the name reaches cards, logs and `list_agents`), else
 * undefined. Rejecting is not an error: the caller derives a name from the task
 * and logs why.
 */
function acceptableChildName(value) {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  if (name === '' || Array.from(name).length > 64) return undefined
  return CHILD_NAME_PATTERN.test(name) ? name : undefined
}

/** Per-parent child names already handed out in this process. */
const seenChildNames = new Map()

/**
 * `task` → a short `[a-z0-9-]` name (`''`/unusable → `'task'`).
 *
 * First {@link NAME_PREFIX_CHARS} characters, lower-cased, every run of
 * non-`[a-z0-9]` folded to one `-`, leading/trailing `-` dropped. Phones home
 * for a mixed task ("Read the matriline index.js …" → `read-the-fis`); a task
 * that starts with Chinese yields `task`, which is honest and still unique.
 */
function deriveChildName(task) {
  try {
    const base = String(task ?? '')
      .slice(0, NAME_PREFIX_CHARS)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return base === '' ? 'task' : base
  } catch {
    return 'task'
  }
}

/**
 * A name still unique inside one parent session: the prefix, then `-2`, `-3`, …
 * Names are counted per session in memory, so a reload restarts the numbering
 * (an acceptable cost of not keeping another durable index).
 */
function uniqueChildName(parentId, task) {
  try {
    const base = deriveChildName(task)
    const key = String(parentId)
    let seen = seenChildNames.get(key)
    if (seen === undefined) {
      seen = new Set()
      seenChildNames.set(key, seen)
    }
    if (!seen.has(base)) {
      seen.add(base)
      return base
    }
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`
      if (!seen.has(candidate)) {
        seen.add(candidate)
        return candidate
      }
    }
    const fallback = `${base}-${Date.now().toString(36)}`
    seen.add(fallback)
    return fallback
  } catch {
    return 'task'
  }
}

/** Remember an explicit name so a later DERIVED name never collides with it. */
function rememberChildName(parentId, name) {
  try {
    if (typeof name !== 'string' || name === '') return
    const key = String(parentId)
    let seen = seenChildNames.get(key)
    if (seen === undefined) {
      seen = new Set()
      seenChildNames.set(key, seen)
    }
    seen.add(name)
  } catch {
    /* naming is a convenience; never fail a dispatch over it */
  }
}

// ---------------------------------------------------------------------------
// P0-3 in-memory run registry (liveness and descendant checks)
// ---------------------------------------------------------------------------

/**
 * `childSessionId → { name, parentId, rootId, status, model, startedAt,
 * endedAt, tokens, kind, worktreeBranch }`.
 *
 * Registered the moment a child starts, refreshed on settle and on
 * `subagent/end`. In memory only: after a plugin reload the table is empty, so a
 * lookup answers "unknown" rather than inventing rows.
 */
const runs = new Map()

/** The ROOT session id a child belongs to. Never throws. */
function runRootOf(ctx, parentHeader, parentId) {
  try {
    const cached = rootOfSession.get(String(parentId))
    if (cached !== undefined) return String(cached)
    if (parentHeader !== undefined && parentHeader.origin === 'subagent') {
      return String(resolveRoot(ctx, parentHeader))
    }
    return String(parentId)
  } catch {
    return String(parentId)
  }
}

/** Create one run-registry entry. Never throws. */
function registerRun(ctx, fields) {
  try {
    const childId = fields?.childId
    if (childId === undefined || childId === null || String(childId) === '') return
    const startedAt = Number(fields?.startedAt)
    runs.set(String(childId), {
      name: String(fields?.name ?? '?'),
      parentId: String(fields?.parentId ?? '?'),
      rootId: String(fields?.rootId ?? fields?.parentId ?? '?'),
      status: 'running',
      model: typeof fields?.model === 'string' && fields.model !== '' ? fields.model : 'inherit',
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      endedAt: undefined,
      tokens: 0,
      kind: String(fields?.kind ?? 'read'),
      worktreeBranch: typeof fields?.worktreeBranch === 'string' ? fields.worktreeBranch : '',
    })
  } catch (error) {
    log(`runs: register FAILED: ${error?.message}`)
  }
}

/** Merge a patch into one run-registry entry; undefined values are ignored. */
function updateRun(childId, patch) {
  try {
    if (childId === undefined || childId === null) return
    const entry = runs.get(String(childId))
    if (entry === undefined || patch === null || typeof patch !== 'object') return
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      entry[key] = value
    }
  } catch (error) {
    log(`runs: update FAILED: ${error?.message}`)
  }
}

/** A `subagent/end` stop reason → the status it means, or undefined. */
function statusOfStopReason(stop) {
  if (stop === 'aborted') return 'interrupted'
  if (stop === 'error' || stop === 'refusal') return 'error'
  if (stop === 'max-tokens') return 'partial'
  if (stop === 'completed') return 'ok'
  return undefined
}

/** Whether one run belongs to `sessionId` or to any of its descendants. */
function runInTree(entry, sessionId) {
  try {
    const target = String(sessionId)
    if (entry?.rootId === target) return true
    let current = entry
    let guard = 0
    while (current !== undefined && guard < 32) {
      if (String(current.parentId) === target) return true
      current = runs.get(String(current.parentId))
      guard += 1
    }
    return false
  } catch {
    return false
  }
}









// ---------------------------------------------------------------------------
// P1-5 result persistence — one JSONL line per settled delegation
// ---------------------------------------------------------------------------

/** Rotation ceiling: a bigger `runs.jsonl` is renamed and a fresh one starts. */
const RUNS_FILE_MAX_BYTES = 5 * 1024 * 1024

/**
 * The delegation ledger. It lives in the PLUGIN's data directory, never in the
 * user's project: a delegated task must not create files inside somebody else's
 * checkout.
 */
const RUNS_FILE = join(ROOT, 'runs.jsonl')

/** The calling agent's workspace root, or the process cwd. Never throws. */
function workspaceRootOf(agent) {
  try {
    const cwd = sessionHeaderOf(agent)?.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim()
  } catch {
    /* fall through to the process directory */
  }
  try {
    const cwd = process.cwd()
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    /* no usable directory: the record is simply not written */
  }
  return ''
}

/** The one JSONL record of a settled result. */
function runRecordOf(parentId, result) {
  let worktree = ''
  try {
    if (typeof result?.worktree?.branch === 'string') worktree = result.worktree.branch
  } catch {
    worktree = ''
  }
  let tokens = 0
  try {
    const total = Number(result?.usage?.totalTokens ?? 0)
    if (Number.isFinite(total) && total > 0) tokens = total
  } catch {
    tokens = 0
  }
  return {
    at: new Date().toISOString(),
    parentId: String(parentId ?? '?'),
    name: String(result?.name ?? '?'),
    status: String(result?.status ?? 'unknown'),
    summary: typeof result?.summary === 'string' ? result.summary : '',
    tokens,
    model: typeof result?.model === 'string' && result.model !== '' ? result.model : 'inherit',
    child: typeof result?.child === 'string' ? result.child : '',
    worktree,
  }
}

/**
 * Append one settled result to {@link RUNS_FILE} (`<data dir>/runs.jsonl`).
 *
 * Over {@link RUNS_FILE_MAX_BYTES} the current file is renamed to
 * `runs.<timestamp>.jsonl` first, then a fresh line is appended: the rename is
 * the atomic step (no copy-then-truncate window, so a reader never sees a
 * partially rewritten ledger), and a name collision gets a counter suffix
 * instead of overwriting the previous rotation. Every failure is logged and
 * swallowed: bookkeeping must never turn a delegation into an error.
 *
 * `agent` is kept in the signature for its callers but no longer decides WHERE
 * the record goes — the ledger is plugin data, not project data.
 */
function appendRunRecord(agent, parentId, result) {
  try {
    mkdirSync(ROOT, { recursive: true, mode: 0o700 })
    try {
      const size = statSync(RUNS_FILE).size
      if (size > RUNS_FILE_MAX_BYTES) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        let rotated = join(ROOT, `runs.${stamp}.jsonl`)
        for (let attempt = 2; existsSync(rotated) && attempt < 100; attempt += 1) {
          rotated = join(ROOT, `runs.${stamp}-${attempt}.jsonl`)
        }
        renameSync(RUNS_FILE, rotated)
        log(`runs.jsonl: rotated at ${size} bytes -> ${rotated}`)
      }
    } catch {
      /* a missing file is the normal first write */
    }
    appendFileSync(RUNS_FILE, `${JSON.stringify(runRecordOf(parentId, result))}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    log(`runs.jsonl write FAILED (ignored): ${error?.message}`)
  }
}

// ---------------------------------------------------------------------------
// P1-6 duplicate dispatch detection
// ---------------------------------------------------------------------------

/** Same task text inside this window is reported as a duplicate. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000

/** `${parentId}:${fingerprint}` → `{ name, lastAt }` (in memory only). */
const duplicateIndex = new Map()

/** djb2 over whitespace-stripped task text, plus its length. */
function fingerprintTask(task) {
  try {
    const text = String(task ?? '').replace(/\s+/g, '')
    let hash = 5381
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
    }
    return `${hash.toString(36)}:${text.length}`
  } catch {
    return '0:0'
  }
}

/** The in-memory key of one task text for one parent; undefined for empty text. */
function duplicateKeyOf(parentId, task) {
  try {
    const text = String(task ?? '')
    if (text.trim() === '') return undefined
    return `${String(parentId)}:${fingerprintTask(text)}`
  } catch {
    return undefined
  }
}

/**
 * Look up (but do NOT record) the earlier run's name for the same task text from
 * the same parent inside the duplicate window.
 *
 * Kept apart from {@link rememberDuplicate} on purpose: a delegation refused
 * before a child exists (write-scope overlap, a failed start) must not leave a
 * fingerprint behind, or the caller's corrected retry would be reported as a
 * duplicate of a run that never happened.
 */
function findDuplicate(parentId, task) {
  try {
    const key = duplicateKeyOf(parentId, task)
    if (key === undefined) return undefined
    const previous = duplicateIndex.get(key)
    if (previous === undefined) return undefined
    return Date.now() - previous.lastAt <= DUPLICATE_WINDOW_MS ? previous.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Record this delegation's fingerprint AFTER the child actually started. The
 * FIRST name of a duplicate chain is kept, so the third copy points at the
 * original run rather than at its copy. The delegation still goes out; only its
 * result says it duplicates. Never throws.
 */
function rememberDuplicate(parentId, task, name, duplicate) {
  try {
    const key = duplicateKeyOf(parentId, task)
    if (key === undefined) return
    const now = Date.now()
    duplicateIndex.set(key, {
      name: duplicate ?? (typeof name === 'string' && name !== '' ? name : '?'),
      lastAt: now,
    })
    if (duplicateIndex.size > 500) {
      for (const [storedKey, entry] of duplicateIndex) {
        if (now - entry.lastAt > DUPLICATE_WINDOW_MS) duplicateIndex.delete(storedKey)
      }
    }
  } catch {
    /* duplicate bookkeeping must never fail a delegation */
  }
}

/** Add `duplicateOf` and the LEADING summary note to one result. Never throws. */
function withDuplicateNote(result, duplicateOf) {
  if (duplicateOf === undefined || result === null || typeof result !== 'object') return result
  try {
    const note = `（重复任务，与 ${duplicateOf} 相同）`
    const summary = typeof result.summary === 'string' ? result.summary : ''
    return {
      ...result,
      duplicateOf,
      summary: composeNoteSummary(summary, note),
    }
  } catch {
    return result
  }
}

/** The ` · dup=<name>` card suffix, or ''. */
function describeDuplicate(value) {
  const name = typeof value?.duplicateOf === 'string' ? value.duplicateOf.trim() : ''
  return name === '' ? '' : ` · dup=${name}`
}

/** The plugin-record type carrying the explicit per-session trim choice. */
const GATE_EVENT_TYPE = 'plugin:matriline/gate'

/**
 * The explicit trim choice recorded in one session's own log, or undefined
 * when this session never made one. The LAST record wins; `undefined` means
 * "follow the official Team switch", which is deliberately different from an
 * explicit `false`.
 */
function gateFromSession(session) {
  let value
  try {
    if (session === undefined) return undefined
    const events = typeof session.ownEvents === 'function'
      ? session.ownEvents()
      : typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (const event of events) {
      if (event?.ignorable !== true || event?.type !== GATE_EVENT_TYPE) continue
      if (typeof event?.data?.enabled === 'boolean') value = event.data.enabled
    }
  } catch (error) {
    log(`gate: record read FAILED: ${error?.message}`)
  }
  return value
}

/** Append the explicit choice unless the same value is already the last record. Never throws. */
async function recordGateOnce(session, enabled) {
  try {
    if (session === undefined || typeof enabled !== 'boolean') return false
    if (gateFromSession(session) === enabled) return false
    const api = await pluginRecordApi()
    if (api === undefined) {
      log(`gate: plugin-record writer unavailable; ${enabled} not persisted on session=${session?.header?.id ?? '?'}`)
      return false
    }
    if (typeof api.SessionClass === 'function' && !(session instanceof api.SessionClass)) {
      log('gate: session module instance differs; refusing appendPluginRecord')
      return false
    }
    api.append(session, GATE_EVENT_TYPE, { enabled })
    log(`gate: recorded ${enabled} on session=${session?.header?.id ?? '?'}`)
    return true
  } catch (error) {
    log(`gate: appendPluginRecord FAILED (trimming unaffected): ${error?.message}`)
    return false
  }
}





/** The SDK package scope, assembled at runtime: this plugin imports no SDK. */
const SDK_SCOPE = ['@deepseek', 'ai'].join('-')

/** The absolute file URL of a path, for a dynamic import. */
function fileUrlOf(path) {
  return encodeURI(`file:///${String(path).replace(/\\/g, '/')}`)
}

/**
 * The host session module's `appendPluginRecord`, when this process can reach it.
 *
 * The plugin itself must not depend on a package it cannot resolve, so this is
 * an OPTIONAL, best-effort capability resolved lazily: the host's session module
 * is imported by the exact file URL the installed host bundle resolves for its
 * own session package, so the module cache returns the SAME instance. Its
 * `Session` class is then used as an identity probe — a live session must
 * satisfy `instanceof` it, otherwise the record append would throw and the
 * caller gets `undefined`. When no route resolves, the plugin keeps working and
 * simply cannot write the durable records.
 */
let pluginRecordApiPromise

/**
 * Whether every route to the plugin-record writer has FAILED in this process.
 *
 * The durable `kind`/`tools`/`skills`/`lease` records are optional (the plugin
 * loads without the SDK), so "no lease record on this session" has two very
 * different meanings: the record was never written (writer missing — the child
 * simply cannot be policed by claim) or it was LOST (a real anomaly). The
 * fail-closed rule is only honest in the second case; treating the first one as
 * refusal would break every resumed writer in a deployment that never had a
 * writer at all.
 */
let pluginRecordUnavailable = false

/** Resolve (once) the optional plugin-record writer. Never rejects. */
function pluginRecordApi() {
  if (pluginRecordApiPromise === undefined) pluginRecordApiPromise = loadPluginRecordApi()
  return pluginRecordApiPromise
}

/** Attempt every reachable route to the writer. Never throws. */
async function loadPluginRecordApi() {
  const specifiers = []
  try {
    const resources = typeof process.resourcesPath === 'string' && process.resourcesPath !== ''
      ? process.resourcesPath
      : join(dirname(process.execPath), 'resources')
    const candidate = join(resources, 'app.asar', 'dsh', 'node_modules', SDK_SCOPE, 'dsh-session', 'lib', 'index.js')
    if (existsSync(candidate)) specifiers.push(fileUrlOf(candidate))
    const unpacked = join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', SDK_SCOPE, 'dsh-session', 'lib', 'index.js')
    if (existsSync(unpacked)) specifiers.push(fileUrlOf(unpacked))
  } catch (error) {
    log(`records: host bundle path FAILED: ${error?.message}`)
  }
  // Built at runtime on purpose: the plugin carries no import of the SDK, so a
  // deployment without it still loads.
  specifiers.push(['@deepseek', 'ai/dsh-session'].join('-'))
  for (const specifier of specifiers) {
    try {
      const module = await import(specifier)
      if (module !== null && typeof module?.appendPluginRecord === 'function') {
        log(`records: plugin-record writer resolved via ${specifier.slice(0, 24)}…`)
        return { append: module.appendPluginRecord, SessionClass: module.Session }
      }
    } catch (error) {
      log(`records: writer route FAILED (${specifier.slice(0, 24)}…): ${error?.message}`)
    }
  }
  log('records: plugin-record writer unavailable; the durable kind/tools/skills/lease records cannot be written')
  pluginRecordUnavailable = true
  return undefined
}

// ---------------------------------------------------------------------------
// `matrilineGate` projection — the explicit per-session trim choice
//
// `{ enabled: null }` means "never chosen, follow the official Team switch";
// `{ enabled: true | false }` is an explicit choice the UI switch can show and
// change without touching Team mode. The client combines this with the
// `agentTeam` projection to render the effective state.
// ---------------------------------------------------------------------------

const gateProjection = {
  key: 'matrilineGate',
  stateVersion: 1,
  stateSchema: LENIENT,
  init: () => ({ enabled: null }),
  apply: (state, event) => {
    try {
      if (event?.ignorable !== true || event?.type !== GATE_EVENT_TYPE) return state
      const enabled = event?.data?.enabled
      return typeof enabled === 'boolean' ? { enabled } : state
    } catch {
      return state
    }
  },
  wire: {
    viewSchema: LENIENT,
    view: state => state,
    summary: true,
  },
}

// ---------------------------------------------------------------------------
// `list_agents` compaction — one post-execute listener, model-facing text only
//
// `list_agents` is the delegation tree's only enumeration surface, but once a
// session owns dozens of children its result costs 3-5K tokens and the model
// usually skims it. `tools/post-execute` is the tool registry's public result
// waterfall: a listener receives `(exec, result, next)` and may return
// `{ kind: 'accept', content }` to replace ONLY the model-facing content. The
// hook below is registered in the plugin's global scope, so it sees every
// agent's call. Everything else delegates with `next()`: another tool, a failed
// result, a shape it cannot parse, or a list that is already short. Fail-open
// is the whole contract — a compaction bug must never swallow a tool result.
// ---------------------------------------------------------------------------

/** Full list at or below this many rows; above it, compress. */
const LIST_AGENTS_COMPACT_OVER = 12
/** At most this many running agent names are listed. */
const LIST_AGENTS_ACTIVE_SHOWN = 10
/** At most this many recently finished agent names are listed. */
const LIST_AGENTS_RECENT_SHOWN = 8

/**
 * One rendered row: `name [status]` followed by an optional ` — description`.
 * The status group is capped (its cell cannot be the whole line), and the
 * description is parsed out of the REMAINDER at its FIRST separator, so a
 * description that itself contains ` — ` (and the root row's `root agent`) is
 * kept whole.
 */
const LIST_AGENTS_ROW = /^(\S+) \[([^\]\n]{1,40})\]([\s\S]*)$/

/** The separator the host's renderer puts between the head and the description. */
const LIST_AGENTS_DESCRIPTION_SEPARATOR = ' — '

/**
 * Parse the structured `value` of a `list_agents` result. `undefined` means
 * "shape not understood": the caller then tries the rendered text, and failing
 * that leaves the result untouched.
 */
function listAgentsRowsFromValue(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const rows = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    // `name` is the current projection; `id` is the earlier one. Both are read
    // verbatim — this function never invents a name.
    const name = typeof entry.name === 'string' && entry.name !== ''
      ? entry.name
      : typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined
    const status = typeof entry.status === 'string' && entry.status !== '' ? entry.status : undefined
    if (name === undefined || status === undefined) return undefined
    // `description` is current; `label` is the earlier field name.
    const description = typeof entry.description === 'string'
      ? entry.description
      : typeof entry.label === 'string' ? entry.label : undefined
    rows.push({ name, status, description, root: description === 'root agent' })
  }
  return rows
}

/**
 * Parse the rendered text form when `value` is absent or unrecognised.
 *
 * Returns `{ rows, unparsedLines }`. A line without a `name [status]` head is a
 * continuation (the host's description may wrap) and is COUNTED, so the caller
 * can tell "a multi-line description" from "the renderer changed shape and rows
 * were lost".
 */
function listAgentsRowsFromText(content) {
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += `${block.text}\n`
    }
  }
  if (text.trim() === '') return undefined
  const rows = []
  let unparsedLines = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    const match = LIST_AGENTS_ROW.exec(line)
    // A line without a `name [status]` head is a wrapped label, not an agent.
    if (match === null) {
      unparsedLines += 1
      continue
    }
    const rest = match[3]
    const separatorAt = rest.indexOf(LIST_AGENTS_DESCRIPTION_SEPARATOR)
    const description = separatorAt < 0
      ? undefined
      : rest.slice(separatorAt + LIST_AGENTS_DESCRIPTION_SEPARATOR.length).trim() || undefined
    rows.push({
      name: match[1],
      status: match[2],
      description,
      root: description === 'root agent',
    })
  }
  return rows.length === 0 ? undefined : { rows, unparsedLines }
}

/** Rows from the structured value if possible, else from the rendered text. */
function listAgentsRowsOf(result) {
  const structured = listAgentsRowsFromValue(result?.value)
  if (structured !== undefined) return { rows: structured, unparsedLines: 0 }
  return listAgentsRowsFromText(result?.content)
}

/**
 * The compact model-facing text. `running` is the only active status; every
 * other row (inactive, or a diagnostic status such as `corrupt`) counts as
 * inactive. The synthetic root-agent row is never reported as "recently
 * finished" — it is the caller's own tree root.
 */
function compactListAgentsText(rows) {
  const active = []
  let inactive = 0
  const diagnostics = []
  for (const row of rows) {
    if (row.status === 'running') active.push(row.name)
    else if (row.status === 'inactive') inactive += 1
    else {
      // A branch the host could not read (corrupt / unsupported / unavailable).
      // The row is still a member the caller can message, so it is NOT silently
      // folded into "inactive, recently finished".
      diagnostics.push(`${row.name}[${String(row.status ?? '?')}]`)
    }
  }
  const shown = active.slice(0, LIST_AGENTS_ACTIVE_SHOWN)
  const overflow = active.length - shown.length
  const finished = []
  for (const row of rows) {
    if (row.status === 'inactive' && row.root !== true) finished.push(row.name)
  }
  const recent = finished.slice(-LIST_AGENTS_RECENT_SHOWN)
  const activeLine = shown.length === 0
    ? 'active: （无）'
    : `active: ${shown.join(', ')}${overflow > 0 ? ` …+${overflow}` : ''}`
  const lines = [
    `共 ${rows.length} 个（active ${active.length} / inactive ${inactive}`
      + `${diagnostics.length === 0 ? '' : ` / 诊断 ${diagnostics.length}`}）`,
    activeLine,
    `最近完成 ${recent.length} 个: ${recent.length === 0 ? '（无）' : recent.join(', ')}`,
  ]
  if (diagnostics.length > 0) {
    const shownDiagnostics = diagnostics.slice(0, LIST_AGENTS_ACTIVE_SHOWN)
    lines.push(
      `诊断（自身仍可 send_message，但下级列表读不到）: ${shownDiagnostics.join(', ')}`
      + `${diagnostics.length > shownDiagnostics.length ? ` …+${diagnostics.length - shownDiagnostics.length}` : ''}`,
    )
  }
  lines.push('完整列表请在右侧栏「子代理拓扑」查看')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// `deliberate` — a multi-participant, multi-round discussion team
//
// Claude Code-style agent teams are felt as "several specialists argue, then one
// answer". The naive way to fake that is to re-dispatch every participant every
// round; each re-dispatch pays a COLD start (system prompt + tools + brief).
// This tool pays that once per participant and then feeds the other stances back
// into the SAME child through the runtime's continuation channel, so one call
// costs N x (rounds + 1) requests instead of N x rounds cold starts:
//   round 1: N fresh read-only children, each with an independent stance;
//   round 2: ONE `send_message` per child (no re-dispatch), then a synthesis.
//
// HOW A CONTINUATION IS WAITED ON — verified against the host's subagent
// manager in the installed DSH 0.2.x build and observed live on this host:
//   - sending a message to a target with no resident Activation RESTORES it,
//     which fires a NEW `subagent/start` (new runId) and accepts the message; a
//     target that is still running receives it at its next step (steer) and gets
//     no new Activation;
//   - the Activation's settlement watcher closes it as soon as the child is idle
//     with an empty inbox, and disposal emits the Activation's SOLE
//     `subagent/end` — before the activation result resolves;
//   - therefore the next `subagent/end` naming that child id after a successful
//     send IS the round's completion, and `settle()` — the same primitive
//     `delegate` waits on — already resolves on exactly that edge. Live check:
//     a settled child answered a second `send_message` and delivered a SECOND
//     settlement notice, which is published right after that end edge.
//   - every spawn child persists `mode: "continuable"`, and `sessionPersistence`
//     + `sessionQuery` are part of the base bundle, so cold resume is available
//     in this deployment. Where it is NOT (no `sendMessage`, a missing child id,
//     or a refused restore: NOT_RESUMABLE / CONTINUATION_UNAVAILABLE …) the
//     round falls back to RE-DISPATCHING the participant with the other stances
//     in its brief, and the result says `resumeUnsupported: true` — a fallback is
//     never dressed up as a resume.
//
// One more runtime detail this tool must respect: a resumed child re-fires
// `agent/created` with `source: "resume"`, and this plugin's hook derives the
// child's kind from the per-parent pending-kind slot. Without the slot the
// restored READER would come back trimmed as a WRITER (write sandbox + the
// minimal writer set), so the round-2 send is wrapped in the same per-parent
// `withKindSlot` window with the slot pinned to `read`.
// ---------------------------------------------------------------------------

const DELIB_MIN_PARTICIPANTS = 2
const DELIB_MAX_PARTICIPANTS = 5
const DELIB_DEFAULT_PARTICIPANTS = 3
const DELIB_MAX_ROUNDS = 2
const DELIB_DEFAULT_ROUNDS = 2
/** Chars of another participant's round-1 stance pasted into round 2. */
const DELIB_STANCE_LIMIT = 300
/** Chars of one participant's FINAL stance pasted into the synthesis prompt. */
const DELIB_SYNTH_INPUT_LIMIT = 1200
/** Chars of a participant's round-2 stance kept in the result. */
const DELIB_FINAL_LIMIT = 600
/** The synthesis child's own wait cap (it never outlives the call deadline). */
const DELIB_SYNTH_BUDGET_MS = 60000
/** How many disagreement pairs get a judge (every judge is one more child). */
const DELIB_MAX_JUDGED = 2
/** Slack over `budgetMs * rounds` for the synthesis and the judges. */
const DELIB_EXTRA_MS = 60000

/** Statuses whose stance may enter a later round or the synthesis. */
function delibUsable(status) {
  const value = String(status ?? '')
  return value === 'ok' || value === 'partial'
}

/** Total wall-clock cap of one `deliberate` call: budgetMs × rounds + 60s. */
function deliberationDeadline(startedAt, budgetMs, rounds) {
  return startedAt + budgetMs * rounds + DELIB_EXTRA_MS
}

/**
 * The round-1 brief: a SELF-CONTAINED independent stance.
 *
 * Deliberately forbids guessing what the others will say — the wire effect of a
 * discussion team only exists when round 1 is independent. Short on purpose: the
 * participant's whole request is this brief plus the reader system prompt.
 */
function deliberateBrief(topic, name) {
  return [
    `你是「讨论团」的参与者之一（${name}）。请独立回答下面的问题，先不要猜测其他参与者的看法。`,
    '',
    `问题：${topic}`,
    '',
    '回答格式（必须全部包含，≤300 字）：',
    '1. 结论（claim）：一句话给出你的判断。',
    '2. 证据：你实际读过的 `path:line`，逐条列出；没有证据就写「无，纯判断」。',
    '3. 置信度：high / medium / low。',
    '',
    '边界：你是只读参与者。可以读文件核对事实，但不要修改任何文件，不要委派子代理。',
    '不要复述问题背景，不要写与结论无关的铺垫；直接给结论、证据、置信度。',
  ].join('\n')
}

/**
 * The round-2 message: the OTHER stances only (≤300 chars each), one explicit
 * question, and no restatement of the topic's background — the child already has
 * its own context, which is the whole point of continuing instead of re-spawning.
 */
function deliberateRoundTwoMessage(topic, selfName, others) {
  return [
    `第 2 轮（你是 ${selfName}，继续上一轮的同一问题，不要复述背景、不要重新调查）。`,
    '',
    `问题：${topic}`,
    '',
    '其他人的第一轮结论摘要：',
    ...others.map(other => `- ${other.name}：${other.stance}`),
    '',
    '看完其他人的结论后，明确回答：',
    '1. 你修正还是坚持？（必须二选一，用「修正」或「坚持」开头）',
    '2. 理由：哪一条让你改变/更确信，为什么（可以指出别人错在哪）。',
    '3. 最终结论：claim + 证据 `path:line` + 置信度。',
    '',
    '规则：≤300 字；只引用你实际读过的文件；不要修改任何文件，不要委派子代理。',
  ].join('\n')
}

/**
 * Degraded round 2 (resume unavailable): a FRESH child gets its own prior
 * stance plus the others' in one brief. This is a re-dispatch and says so.
 */
function deliberateRoundTwoBrief(topic, selfName, selfStance, others) {
  return [
    `你是「讨论团」参与者 ${selfName} 的第 2 轮（第 1 轮的子代理无法可靠续跑，因此重新派发一次）。`,
    '',
    `问题：${topic}`,
    '',
    '你自己第 1 轮的结论：',
    selfStance === '' ? '（无）' : selfStance,
    '',
    '其他人的第一轮结论摘要：',
    ...others.map(other => `- ${other.name}：${other.stance}`),
    '',
    '看完其他人的结论后，明确回答：',
    '1. 你修正还是坚持？（必须二选一，用「修正」或「坚持」开头）',
    '2. 理由：哪一条让你改变/更确信，为什么。',
    '3. 最终结论：claim + 证据 `path:line` + 置信度。',
    '',
    '边界：只读参与者；≤300 字；只引用你实际读过的文件；不要修改文件，不要委派子代理。',
  ].join('\n')
}

/**
 * The synthesis prompt: merge the final stances, distill reusable findings, and
 * name ONLY real contradictions between two named participants.
 *
 * Same three hard rules as the batch reconciler (JSON only, real conflicts only,
 * no own investigation) because it reuses the same lenient parser style; the
 * contract differs only where `deliberate` needs it (names instead of indices).
 */
function deliberateSynthesisPrompt(topic, stances) {
  const blocks = stances.map(stance => [
    `参与者「${stance.name}」的最终结论：`,
    stance.text === '' ? '（空）' : stance.text,
  ].join('\n'))
  return [
    '你是讨论结果的合成者（只读）。下面是同一问题、多个参与者各自给出的最终结论。',
    '你只做三件事：把它们的结论合并成一段话；把可复用的事实抽成 findings；找出真正互相矛盾的两方。',
    '',
    `问题：${topic}`,
    '',
    ...blocks,
    '',
    '规则（全部必须遵守）：',
    '1. consensus：用一段话给出合并后的共识。只依据上面的结论，不要自己另做调查，',
    '   不要补充新事实；互相补充就合并，真有冲突就指出冲突点、说明哪一方说得更足。',
    '2. findings：最多 8 条，每条只一句话，必须是上面结论里已经得出的事实；',
    '   evidence 只填上面出现过、原样照抄的 `path:line`，没有就填空数组 []，不要凑、不要编造。',
    '3. disagreements：只有两方对同一事实给出互斥答案才算。措辞差异、详略不同、侧重点不同',
    '   都不算；没有真矛盾就输出空数组。每条的 between 必须是上面出现过的两个参与者名字，',
    '   point 一句话说明在哪一点上互斥。',
    '4. 只输出一个 JSON 对象，不要散文、不要前后缀、不要 Markdown 代码块，形如',
    '   {"consensus":"合并后的一段结论","findings":[{"claim":"一句结论","evidence":["path:line"]}],'
      + '"disagreements":[{"between":["名字甲","名字乙"],"point":"一句话说明矛盾在哪"}]}',
    '',
    '边界：你只有只读工具，不要修改任何文件，不要委派新的子代理。',
  ].join('\n')
}

/**
 * Parse the synthesis answer leniently: the first `{...}` that parses wins, and
 * every field is independent — a bad `findings` value never costs `consensus`,
 * and a malformed answer degrades to the documented empty synthesis (the call
 * still succeeds). Nothing here throws.
 */
function parseDeliberateAnswer(text, names) {
  const empty = { consensus: '', findings: [], disagreements: [] }
  const json = extractJsonObject(text)
  if (json === undefined) return empty
  let data
  try {
    data = JSON.parse(json)
  } catch {
    return empty
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return empty

  const consensus = typeof data.consensus === 'string' && data.consensus.trim() !== ''
    ? capText(data.consensus, RECONCILE_MERGED_LIMIT)
    : ''

  const findings = []
  if (Array.isArray(data.findings)) {
    for (const entry of data.findings) {
      if (findings.length >= RECONCILE_FINDINGS_MAX) break
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const claim = typeof entry.claim === 'string' ? clipText(entry.claim, RECONCILE_CLAIM_LIMIT) : ''
      if (claim === '') continue
      const evidence = []
      if (Array.isArray(entry.evidence)) {
        for (const item of entry.evidence) {
          if (typeof item !== 'string') continue
          const path = item.trim()
          if (path === '' || evidence.includes(path)) continue
          evidence.push(path)
          if (evidence.length >= RECONCILE_FINDING_EVIDENCE_LIMIT) break
        }
      }
      findings.push({ claim, evidence })
    }
  }

  // Names, not indices: the synthesis is told to name participants, and a name
  // that does not belong to this call is dropped rather than reported as a
  // conflict nobody can act on. Capped at DELIB_MAX_JUDGED because each verdict
  // is one more read-only child.
  const canonical = new Map()
  for (const name of names) canonical.set(String(name).toLowerCase(), String(name))
  const disagreements = []
  if (Array.isArray(data.disagreements)) {
    for (const entry of data.disagreements) {
      if (disagreements.length >= DELIB_MAX_JUDGED) break
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (!Array.isArray(entry.between)) continue
      const pair = []
      for (const raw of entry.between) {
        if (typeof raw !== 'string') continue
        const name = canonical.get(raw.trim().toLowerCase())
        if (name === undefined || pair.includes(name)) continue
        pair.push(name)
      }
      if (pair.length !== 2) continue
      const point = typeof entry.point === 'string' ? clipText(entry.point, RECONCILE_REASON_LIMIT) : ''
      if (point === '') continue
      const duplicate = disagreements.some(existing => (
        (existing.between[0] === pair[0] && existing.between[1] === pair[1])
        || (existing.between[0] === pair[1] && existing.between[1] === pair[0])
      ))
      if (duplicate) continue
      disagreements.push({ between: [pair[0], pair[1]], point, verdict: 'inconclusive', verdictReason: '' })
    }
  }
  return { consensus, findings, disagreements }
}

/** Build one `kind:"deliberation"` result with every field normalized. Never throws. */
function deliberationResult(fields) {
  const rounds = Number(fields?.rounds)
  const roundsSkipped = Number(fields?.roundsSkipped ?? 0)
  const participants = Array.isArray(fields?.participants)
    ? fields.participants.map((row) => {
      const status = STATUSES.includes(String(row?.status)) ? String(row.status) : 'error'
      return {
        name: String(row?.name ?? '?'),
        round1: typeof row?.round1 === 'string' ? row.round1 : '',
        round2: typeof row?.round2 === 'string' ? row.round2 : '',
        status,
      }
    })
    : []
  const disagreements = Array.isArray(fields?.disagreements)
    ? fields.disagreements.map((row) => {
      const between = Array.isArray(row?.between) ? row.between.filter(name => typeof name === 'string').slice(0, 2) : []
      return {
        between: between.length === 2 ? between : ['?', '?'],
        point: typeof row?.point === 'string' ? row.point : '',
        verdict: JUDGE_VERDICTS.includes(row?.verdict) ? row.verdict : 'inconclusive',
        ...(typeof row?.verdictReason === 'string' && row.verdictReason !== '' ? { verdictReason: row.verdictReason } : {}),
      }
    })
    : []
  const findings = Array.isArray(fields?.findings)
    ? fields.findings.filter(row => row !== null && typeof row === 'object')
    : []
  const tokens = Number(fields?.totalTokens ?? 0)
  const elapsed = Number(fields?.elapsedMs ?? 0)
  const error = typeof fields?.error === 'string' && fields.error !== '' ? fields.error : undefined
  let status = 'ok'
  if (error !== undefined && participants.length === 0) status = 'error'
  else if (participants.some(row => row.status !== 'ok')) status = 'partial'
  return {
    kind: 'deliberation',
    status,
    rounds: Number.isInteger(rounds) && rounds >= 0 ? rounds : 0,
    roundsSkipped: Number.isInteger(roundsSkipped) && roundsSkipped >= 0 ? roundsSkipped : 0,
    participants,
    synthesis: {
      consensus: typeof fields?.consensus === 'string' ? fields.consensus : '',
      findings,
      disagreements,
    },
    usage: { totalTokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0 },
    elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0,
    ...(error === undefined ? {} : { error }),
    ...(fields?.resumeUnsupported === true ? { resumeUnsupported: true } : {}),
  }
}

/**
 * Send round 2 to ONE already-settled participant and wait for that round to
 * finish. Never throws.
 *
 * `withKindSlot` + `pendingKind` exist for one reason: a resumed child re-fires
 * `agent/created` (`source: "resume"`) and this plugin's hook reads the kind
 * from that slot. Pinning it to `read` keeps the restored child a reader
 * (7-tool whitelist, read-only sandbox) instead of letting it default to the
 * writer surface. All participants are readers, so sharing the slot is safe.
 *
 * Returns `{ ok: true, status, text, tokens }` once the round-2 end event
 * arrived (status is decideStatus over the BEFORE/AFTER diff of the child's
 * own log), or `{ ok: false, reason }` when the continuation itself could not
 * be established or waited on. Nothing here throws.
 */
async function resumeParticipant(ctx, options) {
  const { pre, childId, name, message, budgetMs, signal } = options
  try {
    if (typeof pre?.subagents?.sendMessage !== 'function') {
      return { ok: false, reason: 'subagents.sendMessage 不可用' }
    }
    if (childId === undefined) return { ok: false, reason: '缺少子会话 id' }

    let knownSession
    try {
      knownSession = ctx.get('sessions')?.get(childId) ?? ctx.get('agents')?.get(childId)?.session
    } catch (error) {
      log(`deliberate: ${name} session pre-capture FAILED: ${error?.message}`)
    }
    // Snapshot the child's log BEFORE round 2 is delivered. The round-2 status
    // is decided from the DIFF against this view, so a denial or tool error the
    // participant recovered from in round 1 is not mistaken for a round-2
    // failure (classification looks at the run, not its whole history).
    const before = inspectChild(ctx, childId, knownSession)

    try {
      await withKindSlot(pre.parentId, async () => {
        pendingKind.set(pre.parentId, 'read')
        try {
          await pre.subagents.sendMessage(
            pre.parent,
            childId,
            [{ type: 'text', text: message }],
            { signal },
          )
        } finally {
          pendingKind.delete(pre.parentId)
        }
      })
    } catch (error) {
      return { ok: false, reason: `sendMessage 失败：${String(error?.message ?? error)}` }
    }
    log(`deliberate: ${name} round 2 delivered (child=${childId}); waiting for subagent/end`)

    // Hold the resumed Session now: a settled child may leave the store, and the
    // round-2 answer has to be readable from it afterwards.
    try {
      knownSession = ctx.get('sessions')?.get(childId)
        ?? ctx.get('agents')?.get(childId)?.session
        ?? knownSession
    } catch (error) {
      log(`deliberate: ${name} resumed session capture FAILED: ${error?.message}`)
    }

    // The NEXT `subagent/end` for this child is the completion of this round
    // (round 1's end already fired before we sent — see the header comment).
    const outcome = await settle(ctx, undefined, childId, budgetMs, signal)
    if (outcome?.via !== 'event') {
      return { ok: false, reason: `等待第 2 轮结束失败（via=${String(outcome?.via ?? '?')}）` }
    }
    const endInfo = outcome.endInfo
    let text = ''
    try {
      text = textOf(endInfo?.lastAssistantMessage).trim()
    } catch (error) {
      log(`deliberate: ${name} end message read FAILED: ${error?.message}`)
    }

    let tokens = 0
    let status = 'error'
    try {
      // Prefer a FRESH lookup after settlement (the store may hand back the same
      // Session; `inspectChild` falls back to the captured one), because the
      // cumulative usage of this child is what round 2 should report.
      let fresh
      try {
        fresh = ctx.get('sessions')?.get(childId) ?? ctx.get('agents')?.get(childId)?.session
      } catch (error) {
        log(`deliberate: ${name} session re-lookup FAILED: ${error?.message}`)
      }
      const after = inspectChild(ctx, childId, fresh ?? knownSession)
      if (text === '') text = String(after.lastAssistant ?? '').trim()
      tokens = Number(after.usage?.totalTokens ?? 0) || 0
      // Only denials / tool errors that appeared DURING this round count; the
      // explicit end stop reason still outranks them inside decideStatus.
      const newDenials = after.denials.slice(before.denials.length)
      const newDenialCount = Math.max(0, (after.denialCount ?? 0) - (before.denialCount ?? 0))
      const newToolErrors = Math.max(0, (after.toolErrorCount ?? 0) - (before.toolErrorCount ?? 0))
      status = decideStatus({
        ...after,
        denials: newDenials,
        denialCount: newDenialCount,
        toolError: newToolErrors > 0,
        depthDenied: after.depthDenied === true && before.depthDenied !== true,
        lastAssistant: text,
      }, { via: 'event', endInfo })
    } catch (error) {
      log(`deliberate: ${name} round-2 inspection FAILED: ${error?.message}`)
      return { ok: false, reason: `第 2 轮结果读取失败：${String(error?.message ?? error)}` }
    }
    log(`deliberate: ${name} round 2 settled status=${status} tokens=${tokens}`)
    return { ok: true, status, text: clipText(text, DELIB_FINAL_LIMIT), tokens }
  } catch (error) {
    // Backstop: one participant's continuation can never fail the discussion.
    return { ok: false, reason: `续跑失败：${String(error?.message ?? error)}` }
  }
}

/**
 * Merge the final stances and arbitrate the real conflicts.
 *
 * Reuses the batch reconciler's machinery: one read-only synthesis child
 * (`startChild` + `settleChild`, JSON contract, lenient parse) and the internal
 * judge kernel (`runJudge`) for up to {@link DELIB_MAX_JUDGED} disagreements.
 * A failure at ANY step degrades to the documented empty synthesis and never
 * fails the call. Returns `{ consensus, disagreements, findings, tokens }`.
 */
async function synthesizeDeliberation(ctx, options) {
  const { pre, topic, stances, deadline, signal } = options
  const empty = { consensus: '', disagreements: [], findings: [], tokens: 0 }
  try {
    if (stances.length < 2) {
      log(`deliberate: synthesis SKIPPED (${stances.length} usable stance(s) < 2)`)
      return empty
    }
    const remaining = () => (deadline === undefined ? DELIB_SYNTH_BUDGET_MS : deadline - Date.now())
    if (remaining() < MIN_BUDGET_MS) {
      log('deliberate: synthesis SKIPPED (call deadline exhausted)')
      return empty
    }

    const name = uniqueChildName(pre.parentId, 'delib-synth')
    const synthesisStarted = Date.now()
    let started
    try {
      started = await startChild(ctx, {
        parentId: pre.parentId,
        parent: pre.parent,
        subagents: pre.subagents,
        providerName: pre.providerName,
        task: deliberateSynthesisPrompt(topic, stances),
        kind: 'read',
        name,
        signal,
      })
    } catch (error) {
      log(`deliberate: synthesis start FAILED: ${String(error?.message ?? error)}`)
      return empty
    }
    const childId = childIdOf(started)
    log(`deliberate: started ${name} (child=${childId ?? '?'}, ${stances.length} stance(s))`)
    // The synthesis child is internal but real: track it like a delegation row.
    registerRun(ctx, {
      childId,
      name,
      parentId: pre.parentId,
      rootId: runRootOf(ctx, pre.parent?.session?.header, pre.parentId),
      model: 'inherit',
      startedAt: synthesisStarted,
      kind: 'read',
    })
    const settled = await settleChild(ctx, {
      started,
      childId,
      name,
      kind: 'read',
      budgetMs: Math.min(DELIB_SYNTH_BUDGET_MS, Math.max(MIN_BUDGET_MS, remaining())),
      signal,
      startedAt: synthesisStarted,
      raw: true,
    })
    const synthesisStatus = String(settled?.status ?? 'error')
    let tokens = Number(settled?.usage?.totalTokens ?? 0) || 0
    updateRun(childId, {
      status: synthesisStatus,
      endedAt: Date.now(),
      tokens,
      ...(typeof settled?.model === 'string' && settled.model !== '' ? { model: settled.model } : {}),
    })
    if (!delibUsable(synthesisStatus)) {
      log(`deliberate: synthesis ended ${synthesisStatus}; consensus left empty`)
      return { ...empty, tokens }
    }
    const rawAnswer = typeof settled?.raw === 'string' && settled.raw !== ''
      ? settled.raw
      : (typeof settled?.summary === 'string' ? settled.summary : '')
    const parsed = parseDeliberateAnswer(rawAnswer, stances.map(stance => stance.name))
    log(
      `deliberate: synthesis status=${synthesisStatus} consensus=${parsed.consensus === '' ? 'empty' : `${parsed.consensus.length} chars`} `
      + `findings=${parsed.findings.length} disagreements=${parsed.disagreements.length}`,
    )

    // At most DELIB_MAX_JUDGED (already capped while parsing) judged, each one a
    // fresh read-only child with the two stances and the evidence paths they
    // already carry (`evidenceOfResult` lifts `path:line` tokens from the text).
    for (const pair of parsed.disagreements) {
      const left = stances.find(stance => stance.name === pair.between[0])
      const right = stances.find(stance => stance.name === pair.between[1])
      if (left === undefined || right === undefined) {
        log(`deliberate: disagreement ${pair.between.join('/')} does not name two stances — dropped`)
        continue
      }
      const judgeBudget = Math.min(DEFAULT_JUDGE_BUDGET_MS, remaining())
      if (judgeBudget < MIN_BUDGET_MS) {
        pair.verdictReason = '总时长预算已用尽，未自动裁决'
        log(`deliberate: judge SKIPPED for ${pair.between.join('/')} (${judgeBudget}ms left)`)
        continue
      }
      try {
        const judged = await runJudge(pre.parent, {
          ctx,
          question: topic,
          a: { claim: left.text, evidence: evidenceOfResult({ summary: left.text }) },
          b: { claim: right.text, evidence: evidenceOfResult({ summary: right.text }) },
          budgetMs: judgeBudget,
          signal,
        })
        pair.verdict = JUDGE_VERDICTS.includes(judged?.verdict) ? judged.verdict : 'inconclusive'
        if (typeof judged?.reason === 'string') pair.verdictReason = clipText(judged.reason, JUDGE_REASON_LIMIT)
        tokens += Number(judged?.usage?.totalTokens ?? 0) || 0
      } catch (error) {
        log(`deliberate: judge FAILED for ${pair.between.join('/')}: ${String(error?.message ?? error)}`)
      }
    }
    return { consensus: parsed.consensus, disagreements: parsed.disagreements, findings: parsed.findings, tokens }
  } catch (error) {
    // Absolute backstop: the synthesis never fails the call.
    log(`deliberate: synthesis FAILED (consensus left empty): ${String(error?.message ?? error)}`)
    return empty
  }
}

/**
 * The whole `deliberate` kernel. Never throws: every failure path returns a
 * `kind:"deliberation"` object, and a bad parameter is a REFUSAL with an
 * explanatory `error` instead of a spent child.
 */
async function runDeliberation(ctx, options) {
  const startedAt = Date.now()
  const spent = () => Date.now() - startedAt
  const args = options?.args ?? {}
  const exec = options?.exec
  // `sendMessage` calls `signal.throwIfAborted()`, so it always needs a signal;
  // the host supplies one, and a stub/degenerate exec gets a never-aborted one.
  const signal = exec?.signal ?? new AbortController().signal
  /** A refusal that never started a child. */
  const refuse = (message) => {
    log(`deliberate REFUSED: ${message}`)
    return deliberationResult({ rounds: 0, participants: [], elapsedMs: spent(), error: message })
  }

  try {
    const topic = typeof args?.topic === 'string' ? args.topic.trim() : ''
    if (topic === '') return refuse('deliberate 需要非空 topic（一句话说明要讨论的问题）')

    // Hard cost guard: a discussion is N x (rounds + 1) REQUESTS. The upper
    // bounds are refusals, not clamps, so a typo can never burn 100k+ tokens.
    const participantsInput = args?.participants ?? DELIB_DEFAULT_PARTICIPANTS
    const participants = Number(participantsInput)
    if (!Number.isInteger(participants) || participants < DELIB_MIN_PARTICIPANTS || participants > DELIB_MAX_PARTICIPANTS) {
      return refuse(`participants 必须是 ${DELIB_MIN_PARTICIPANTS}..${DELIB_MAX_PARTICIPANTS} 的整数（收到 ${JSON.stringify(participantsInput)}）；上限 ${DELIB_MAX_PARTICIPANTS} 是为了避免一次调用烧掉几十万 token`)
    }
    const roundsInput = args?.rounds ?? DELIB_DEFAULT_ROUNDS
    const rounds = Number(roundsInput)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > DELIB_MAX_ROUNDS) {
      return refuse(`rounds 必须是 1..${DELIB_MAX_ROUNDS} 的整数（收到 ${JSON.stringify(roundsInput)}）；rounds=1 只收独立立场，不做第 2 轮回灌`)
    }
    if (args?.kind !== undefined && args.kind !== 'read') {
      return refuse(`deliberate 的参与者一律是只读的（kind="read"）；v1 不做写入型讨论，因此 kind=${JSON.stringify(args.kind)} 被拒绝。想改文件请用 delegate(kind="write")`)
    }
    const budgetMs = clampBudget(args?.budgetMs ?? 180000)
    // Total wall clock = per-wait budget × rounds + slack for synthesis/judges.
    const deadline = deliberationDeadline(startedAt, budgetMs, rounds)

    let pre
    try {
      pre = preflight(ctx, exec)
    } catch (error) {
      return refuse(`deliberate 无法运行：${String(error?.message ?? error)}`)
    }
    // Every participant is a READER, so the monotonic privilege check runs with
    // `read` — a read-only caller is allowed, a writer is never needed here.
    const privilege = privilegeCheck(pre.parentId, 'read', pre.parent)
    if (!privilege.allowed) return refuse(privilege.message)

    const canResume = typeof pre.subagents?.sendMessage === 'function'
    let resumeUnsupported = false
    let resumeFailure = ''

    // ---- round 1: N independent, read-only participants, started in parallel --
    const rows = await Promise.all(Array.from({ length: participants }, async (_value, index) => {
      const name = uniqueChildName(pre.parentId, `delib-${index + 1}`)
      const row = { name, round1: '', round2: '', status: 'error', childId: undefined, tokens: 0 }
      const participantStartedAt = Date.now()
      try {
        const started = await startChild(ctx, {
          parentId: pre.parentId,
          parent: pre.parent,
          subagents: pre.subagents,
          providerName: pre.providerName,
          task: deliberateBrief(topic, name),
          kind: 'read',
          name,
          signal,
        })
        row.childId = childIdOf(started)
        const remaining = Math.max(MIN_BUDGET_MS, Math.min(budgetMs, deadline - Date.now()))
        const settled = await settleChild(ctx, {
          started,
          childId: row.childId,
          name,
          kind: 'read',
          budgetMs: remaining,
          signal,
          startedAt: participantStartedAt,
        })
        row.status = String(settled?.status ?? 'error')
        row.round1 = typeof settled?.summary === 'string' ? settled.summary : ''
        row.tokens = Number(settled?.usage?.totalTokens ?? 0) || 0
        log(`deliberate: ${name} round 1 status=${row.status} child=${row.childId ?? '?'} tokens=${row.tokens}`)
        return row
      } catch (error) {
        // One participant's failed start/settle is ONE row, never the call.
        const message = String(error?.message ?? error)
        log(`deliberate: ${name} round 1 FAILED: ${message}`)
        row.status = 'error'
        row.round1 = summarize(`deliberate: 参与者启动失败：${message}`)
        return row
      }
    }))

    // ---- round 2: continue the SAME child; re-dispatch only as a fallback -----
    // `roundsSkipped` counts participants whose round 2 was NOT executed because
    // the call deadline was already exhausted (no child is started for them).
    let roundsSkipped = 0
    let roundTwoDegraded = 0
    if (rounds > 1) {
      await Promise.all(rows.map(async (row) => {
        try {
          if (!delibUsable(row.status) || String(row.round1).trim() === '') return
          const others = rows
            .filter(other => other !== row && delibUsable(other.status) && String(other.round1).trim() !== '')
            .map(other => ({ name: other.name, stance: capText(other.round1, DELIB_STANCE_LIMIT) }))
          if (others.length === 0) return
          if (deadline - Date.now() < MIN_BUDGET_MS) {
            roundsSkipped += 1
            row.status = 'partial'
            log(`deliberate: ${row.name} round 2 SKIPPED (call deadline exhausted; no child started)`)
            return
          }
          const waitBudget = Math.max(MIN_BUDGET_MS, Math.min(budgetMs, deadline - Date.now()))

          let resumed = { ok: false, reason: canResume ? '未尝试' : 'subagents.sendMessage 不可用' }
          if (canResume) {
            resumed = await resumeParticipant(ctx, {
              pre,
              childId: row.childId,
              name: row.name,
              message: deliberateRoundTwoMessage(topic, row.name, others),
              budgetMs: waitBudget,
              signal,
            })
          }
          if (resumed.ok) {
            row.tokens = Math.max(row.tokens, Number(resumed.tokens ?? 0) || 0)
            // The resumed round's OWN status decides: a denied / timed-out /
            // interrupted round 2 is not an "ok" stance just because the end
            // event arrived. An unusable round 2 keeps round 1 as the visible
            // (and synthesizable) stance.
            if (delibUsable(resumed.status) && String(resumed.text).trim() !== '') {
              row.round2 = resumed.text
              row.status = resumed.status
            } else {
              row.round2 = ''
              row.status = 'partial'
              roundTwoDegraded += 1
            }
            log(`deliberate: ${row.name} round 2 (resumed) status=${row.status} reason=${String(resumed.status)} tokens=${row.tokens}`)
            return
          }

          // The caller aborted: never spend another child on this round.
          if (signal.aborted === true) {
            row.status = 'partial'
            log(`deliberate: ${row.name} round 2 stopped (caller aborted)`)
            return
          }

          // DEGRADED PATH — the continuation could not be established OR waited
          // on reliably. Re-dispatch the participant instead and say so in the
          // result (`resumeUnsupported: true`); never label this a resume.
          resumeUnsupported = true
          if (resumeFailure === '') resumeFailure = String(resumed.reason ?? '未知原因')
          log(`deliberate: ${row.name} resume UNSUPPORTED (${resumed.reason}); re-dispatching round 2`)
          // A re-dispatch is a NEW child: start it only when a real wait budget
          // remains. Math.max(MIN_BUDGET_MS, …) used to launch a child that could
          // only time out after the call deadline.
          if (deadline - Date.now() < MIN_BUDGET_MS) {
            roundsSkipped += 1
            row.status = 'partial'
            log(`deliberate: ${row.name} round 2 re-dispatch SKIPPED (call deadline exhausted)`)
            return
          }
          try {
            const name2 = uniqueChildName(pre.parentId, `delib-${row.name.replace(/^delib-/, '')}-r2`)
            const childStartedAt = Date.now()
            const started = await startChild(ctx, {
              parentId: pre.parentId,
              parent: pre.parent,
              subagents: pre.subagents,
              providerName: pre.providerName,
              task: deliberateRoundTwoBrief(topic, row.name, capText(row.round1, DELIB_STANCE_LIMIT * 2), others),
              kind: 'read',
              name: name2,
              signal,
            })
            const childId = childIdOf(started)
            const settled = await settleChild(ctx, {
              started,
              childId,
              name: name2,
              kind: 'read',
              budgetMs: Math.min(budgetMs, deadline - Date.now()),
              signal,
              startedAt: childStartedAt,
            })
            const status = String(settled?.status ?? 'error')
            const text = typeof settled?.summary === 'string' ? settled.summary : ''
            row.tokens += Number(settled?.usage?.totalTokens ?? 0) || 0
            if (delibUsable(status) && text.trim() !== '') {
              row.round2 = text
              row.status = status
            } else {
              row.round2 = ''
              row.status = 'partial'
              roundTwoDegraded += 1
            }
            log(`deliberate: ${row.name} round 2 (re-dispatched) status=${row.status}`)
          } catch (error) {
            row.status = 'partial'
            log(`deliberate: ${row.name} round 2 re-dispatch FAILED: ${String(error?.message ?? error)}`)
          }
        } catch (error) {
          // Per-participant backstop: the other participants keep their rounds.
          row.status = 'partial'
          log(`deliberate: ${row.name} round 2 FAILED: ${String(error?.message ?? error)}`)
        }
      }))
    }

    // ---- synthesis (+ up to 2 judged disagreements) --------------------------
    const stances = rows
      .filter(row => delibUsable(row.status))
      .map(row => ({
        name: row.name,
        text: capText(String(row.round2).trim() !== '' ? row.round2 : row.round1, DELIB_SYNTH_INPUT_LIMIT),
      }))
      .filter(stance => stance.text.trim() !== '')
    const synthesis = await synthesizeDeliberation(ctx, { pre, topic, stances, deadline, signal })

    let totalTokens = Number(synthesis.tokens ?? 0) || 0
    for (const row of rows) totalTokens += Number(row.tokens ?? 0) || 0

    // Every degradation that cost a round is said in one place; the call still
    // returns a well-formed, `partial` deliberation instead of failing.
    const notes = []
    if (resumeUnsupported) notes.push(`第 2 轮有参与者无法可靠续跑（${resumeFailure}），已降级为重派：resumeUnsupported=true`)
    if (roundsSkipped > 0) notes.push(`总时长预算不足，第 2 轮有 ${roundsSkipped} 个参与者未执行（保留第 1 轮立场，partial）`)
    if (roundTwoDegraded > 0) notes.push(`第 2 轮有 ${roundTwoDegraded} 个参与者未给出可用结论，已保留其第 1 轮立场（partial）`)
    const value = deliberationResult({
      rounds,
      roundsSkipped,
      participants: rows,
      consensus: synthesis.consensus,
      disagreements: synthesis.disagreements,
      findings: synthesis.findings,
      totalTokens,
      elapsedMs: spent(),
      resumeUnsupported,
      ...(notes.length === 0 ? {} : { error: notes.join('；') }),
    })
    log(
      `deliberate: done rounds=${rounds} participants=${value.participants.length} `
      + `status=${value.status} tokens=${totalTokens} elapsed=${value.elapsedMs}ms resumeUnsupported=${String(resumeUnsupported)}`,
    )
    return value
  } catch (error) {
    // Absolute backstop: `deliberate` never throws an uncaught error.
    const message = String(error?.message ?? error)
    log(`deliberate RESULT FAILED: ${message}`)
    return deliberationResult({
      rounds: 0,
      participants: [],
      elapsedMs: spent(),
      error: `deliberate 内部错误：${message}`,
    })
  }
}

/**
 * Apply one explicit choice to a LIVE root agent: the tool-surface restriction,
 * the trigger section (on enable only), and the projection record. A session
 * without a live agent only gets the persisted choice; its agent/created path
 * reads it later.
 */
function applyChoiceToLive(ctx, sessionId, enabled) {
  try {
    const agents = ctx.get('agents')
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) return
    if (enabled) {
      restrictDelegationSurface(agent, sessionId, 'settings-on')
    } else {
      releaseSurfaceRestriction(sessionId, 'settings-off')
    }
    recordGateOnce(agent.session, enabled)
      .catch(error => log(`gate: settings record FAILED for session=${sessionId}: ${error?.message}`))
    log(`settings: session=${sessionId} trim=${String(enabled)}`)
  } catch (error) {
    log(`settings: apply to live session=${sessionId} FAILED: ${error?.message}`)
  }
}

/** Fold changed config entries into the gate and the live agents. */
function applyConfigSnapshot(ctx, next, prev) {
  const nextSessions = configSessions(next)
  const prevSessions = configSessions(prev)
  const ids = new Set([...Object.keys(prevSessions), ...Object.keys(nextSessions)])
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue
    if (prevSessions[id] === nextSessions[id]) continue
    const enabled = nextSessions[id]
    if (typeof enabled === 'boolean') {
      sessionChoice.set(id, enabled)
      setOn(id, enabled)
      applyChoiceToLive(ctx, id, enabled)
    } else {
      sessionChoice.delete(id)
      clearOn(id)
      applyChoiceToLive(ctx, id, true)
    }
  }
}

const STATE_STORE_KEY = Symbol.for('dsh-matriline.state')

/**
 * Subscribe to the process-wide store published by the profile-owned
 * `matriline-state` entry. They are sibling fibers, so a Cordis service would
 * not be visible across them; the store is created by the state entry and
 * survives its fiber reloads.
 */
function installStateBridge(ctx) {
  let stopped = false
  let timer
  const readStore = () => globalThis[STATE_STORE_KEY]
  const listener = (next, prev) => {
    applyConfigSnapshot(ctx, { sessions: next }, { sessions: prev })
  }
  const cleanup = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    const store = readStore()
    if (store !== undefined && store.listeners !== undefined) store.listeners.delete(listener)
  }
  const connect = (attempt) => {
    if (stopped) return
    const store = readStore()
    if (store === undefined || store.listeners === undefined) {
      // The entry can appear *after* this fiber applied: a profile patch edit
      // recomposes the tree without re-applying unchanged entries, so a 30s
      // give-up would leave the switch permanently dead in that process.
      // Poll fast through boot, then keep waiting slowly.
      if (attempt === 600) log('state: matriline-state entry still absent after 30s; still waiting')
      timer = setTimeout(() => connect(attempt + 1), attempt < 600 ? 50 : 500)
      return
    }
    store.listeners.add(listener)
    applyConfigSnapshot(ctx, { sessions: store.sessions }, { sessions: {} })
    log('state: bridge connected')
  }
  connect(0)
  try {
    ctx.effect(() => cleanup)
  } catch (error) {
    log(`state: effect FAILED: ${error?.message}`)
  }
}

/** Install the child-composition hook, the edges projection, and the tools. */
export function apply(ctx) {
  // One line so a user can find the log / flags / config without reading code:
  // the data directory is resolved at load time, never baked into the package.
  log(`apply: loaded (data dir: ${ROOT})`)

  let edges
  try {
    Promise.resolve(ctx.sessionProjections.register(edgesProjection))
      .then((handle) => {
        edges = handle
        log('projection subagentEdges registered')
      })
      .catch((error) => log(`projection register FAILED: ${error?.message}`))
  } catch (error) {
    log(`projection register threw: ${error?.message}`)
  }

  // `matrilineGate` — the explicit per-session trim choice, so the model-menu
  // switch can render it. Absent or `null` means "never chosen" (default ON);
  // true/false is the choice written through the `matriline-state` entry.
  try {
    Promise.resolve(ctx.sessionProjections.register(gateProjection))
      .then(() => log('projection matrilineGate registered'))
      .catch((error) => log(`projection matrilineGate register FAILED: ${error?.message}`))
  } catch (error) {
    log(`projection matrilineGate register threw: ${error?.message}`)
  }

  // The switch's write path: no slash commands, no chat rows. The client edits
  // the profile-owned `matriline-state` entry; this bridge owns the host side.
  installStateBridge(ctx)


  // `delegate(task, kind)` — the kind-aware entry point. The official `subagent`
  // tool has no way to say WHAT KIND of work it is handing out, so every child
  // used to be treated as a reader. This tool tells us before the child exists.
  try {
    ctx.effect(() => ctx.tools.register({
      name: 'delegate',
      description:
        'Delegate ONE self-contained task to a subagent with an explicit capability set. '
        + 'kind="read" (default) = cheap read-only reader (~1.5K tokens); "verify" = the same; '
        + '"write" = workspace-write sandbox plus a MINIMAL tool set unless `tools` says otherwise. '
        + 'The child cannot see this conversation, so `task` must carry everything. Status comes '
        + 'from its own log, not its wording. Long task: wait:false. A budget timeout '
        + 'DETACHES by default: the child keeps running (and a writer keeps its write '
        + 'lease), so resume it with send_message or stop it with cancel_subagent; '
        + '`timeoutAction: interrupt` stops it instead and `maxRuntimeMs` caps its lifetime.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The complete, self-contained task for the subagent.',
          },
          kind: {
            type: 'string',
            enum: ['read', 'write', 'verify'],
            description: 'read (default) | write | verify.',
          },
          name: {
            type: 'string',
            description: '`<topic>-<n>`, 1..64 chars of letters/digits/._- (Unicode letters allowed); derived from task if omitted or unusable.',
          },
          scope: {
            type: 'array',
            items: { type: 'string' },
            description: 'write: writable paths (`dir/**` = tree); omit = whole workspace; conflicts refused (WRITE_SCOPE_*).',
          },
          isolate: {
            type: 'boolean',
            default: false,
            description: 'write: own git worktree, no scope check; row has worktree/worktreeError.',
          },
          skills: {
            type: 'boolean',
            default: false,
            description: 'Keep `skill`; the catalog message it adds breaks that session\'s prompt cache. Stripped by default.',
          },
          tools: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'write: "minimal" (default) | "full" | names[]; ignored for read/verify.',
          },
          wait: {
            type: 'boolean',
            default: true,
            description: 'Default true; false returns at once, the answer arrives as a message.',
          },
          budgetMs: {
            type: 'number',
            default: DEFAULT_BUDGET_MS,
            description: `Wait cap ms when wait is true (default ${DEFAULT_BUDGET_MS}); timeout keeps the child.`,
          },
          timeoutAction: {
            type: 'string',
            enum: ['detach', 'interrupt'],
            default: 'detach',
            description: 'On the budget timeout: detach (default) leaves the child running and keeps its write lease; interrupt stops it so no writer is left behind.',
          },
          maxRuntimeMs: {
            type: 'number',
            default: 0,
            description: 'Cap on the CHILD lifetime in ms, independent of wait and of the wait budget: 0 = no cap, > 0 interrupts the child once exceeded.',
          },
          model: {
            type: 'string',
            description: '"provider/model"; omit to inherit this session\'s. Refused while the official '
              + 'subagent model-selection switch is off, and limited to that switch\'s allowed models while it is on.',
          },
          provider: {
            type: 'string',
            description: 'For a bare `model`; ignored when `model` has "/".',
          },
          reasoningEffort: {
            type: 'string',
            description: 'Effort id for the model (e.g. "high"). The same official model-selection switch governs it.',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: activationResultProperties(),
          required: ['kind', 'name'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          try {
            const name = String(value?.name ?? '?')
            if (value?.status === undefined) {
              return [{ type: 'text', text: `started subagent ${name}${describeRoute(value)}${describeWorktreeBadge(value)}${describeDuplicate(value)}` }]
            }
            const lines = [
              `subagent ${name}: ${value.status} (${Number(value.elapsedMs ?? 0)}ms)${describeRoute(value)}${describeContextBadge(value)}${describeWorktreeBadge(value)}${describeDuplicate(value)}`,
            ]
            // The summary is the ONLY machine-readable reason on the card: an
            // error row that hides it is indistinguishable from "it broke".
            if (typeof value.summary === 'string' && value.summary.trim() !== '') {
              lines.push(clipText(value.summary, DISPLAY_TEXT_LIMIT))
            }
            const worktreeError = describeWorktreeError(value)
            if (worktreeError !== undefined) lines.push(worktreeError)
            const contextWarning = describeContextWarning(value)
            if (contextWarning !== undefined) lines.push(contextWarning)
            const denials = describeDenials(value.denials)
            if (denials !== undefined) lines.push(denials)
            if (typeof value.child === 'string') lines.push(`child session: ${value.child}`)
            return [{ type: 'text', text: lines.join('\n') }]
          } catch {
            return [{ type: 'text', text: 'delegate finished' }]
          }
        },
      },
      // Parallel-safe on purpose. The only shared state a delegation pass touches
      // is a per-parent SLOT (kind / skills / isolation / worktree promise), and
      // "set slot → startActivation (which fires `agent/created` before it
      // returns) → clear slot" is serialized per parent by `withKindSlot`; every
      // other table is either written synchronously (no await between check and
      // write: write leases, naming, duplicate index, run registry) or keyed by
      // the child session id. The SECONDS are spent in the wait for the child,
      // which is outside that lock — so declaring the whole call exclusive (the
      // old `false`) merely queued concurrent delegations behind the slowest one.
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const startedAt = Date.now()
        // wait is on unless the caller explicitly turned it off; an unknown
        // value means "keep the documented default".
        const wait = args?.wait !== false
        const budgetMs = clampBudget(args?.budgetMs)
        const timeoutAction = normalizeTimeoutAction(args?.timeoutAction)
        const maxRuntimeMs = clampMaxRuntime(args?.maxRuntimeMs)
        const spent = () => Date.now() - startedAt

        // A delegation needs a real brief: a missing / empty / non-string task
        // used to start a child with no instructions and burn a whole request.
        const task = typeof args?.task === 'string' ? args.task : ''
        if (task.trim() === '') {
          log('delegate REFUSED task: `task` must be a non-empty string')
          return {
            kind: 'activation',
            name: deriveChildName(task),
            status: 'error',
            summary: summarize('delegate: `task` must be a non-empty string'),
            denials: [],
            usage: zeroUsage(),
            elapsedMs: spent(),
          }
        }

        const kind = normalizeKind(args?.kind)
        // The name is caller-supplied text that reaches cards, logs and the runs
        // table, so it is bounded and restricted to letters/digits/._- (Unicode
        // letters allowed). An unusable name is not refused: the child gets a
        // derived one and the reason is logged.
        const named = acceptableChildName(args?.name)
        if (named === undefined && typeof args?.name === 'string' && args.name.trim() !== '') {
          log(`delegate: name ${JSON.stringify(clipText(args.name, 80))} is not usable (1..64 chars of letters/digits/._-); using a derived name`)
        }
        const requestedName = named ?? deriveChildName(task)
        // Tier 3, opt-in per delegation. Ignored for a reader/verifier — the
        // note below is how the caller learns that, without a refusal.
        const isolate = args?.isolate === true
        const isolateNote = isolate && kind !== 'write' ? ISOLATE_IGNORED_NOTE : undefined
        if (isolateNote !== undefined) log(`delegate: ${isolateNote} (kind=${kind})`)
        // `tools` only means something for a WRITER: a reader/verifier already has
        // a fixed whitelist, so a value passed there is ignored AND said so.
        const toolsProfile = resolveToolsProfile(args?.tools, ' (delegate)')
        const toolsNote = kind !== 'write' && args?.tools !== undefined ? TOOLS_IGNORED_NOTE : undefined
        if (toolsNote !== undefined) log(`delegate: ${toolsNote} (kind=${kind})`)
        const ignoredNotes = [isolateNote, toolsNote].filter(note => note !== undefined)

        // Model selection is parsed here only for SHAPE: an unusable
        // provider/model pair is refused with status "error". Authorization
        // against the official model-selection switch and existence in the
        // provider catalog are decided after preflight and before any child
        // starts; omitting every field inherits the parent route and skips both.
        const choice = parseModelChoice(args)
        if (!choice.ok) {
          log(`delegate REFUSED model: ${choice.message}`)
          return {
            kind: 'activation',
            name: requestedName,
            status: 'error',
            summary: summarize(`delegate: ${choice.message}`),
            denials: [],
            usage: zeroUsage(),
            elapsedMs: spent(),
          }
        }
        const withModel = { model: choice.model ?? 'inherit' }

        // The only path allowed to throw is the `wait: false` one, whose
        // callers poll the notice stream and depend on `startActivation` errors.
        let pre
        try {
          pre = preflight(ctx, exec)
        } catch (error) {
          const message = String(error?.message ?? error)
          log(`delegate PREFLIGHT FAILED (kind=${kind}): ${message}`)
          if (!wait) throw new Error(message)
          return {
            kind: 'activation',
            name: requestedName,
            status: 'error',
            summary: summarize(`delegate could not run: ${message}`),
            denials: [],
            usage: zeroUsage(),
            ...withModel,
            elapsedMs: spent(),
          }
        }

        // The caller may have aborted while preflight ran: starting a child
        // after that would leave an untracked run nobody waits for.
        if (exec?.signal?.aborted === true) {
          log(`delegate: aborted before start (kind=${kind}); no child started`)
          return {
            kind: 'activation',
            name: requestedName,
            status: 'interrupted',
            summary: summarize('delegate: the call was aborted before the child started'),
            denials: [],
            usage: zeroUsage(),
            ...withModel,
            elapsedMs: spent(),
          }
        }

        // Monotonic privilege: a child may not delegate above the kind it was
        // given, otherwise a read-only reader could launder a write through a
        // grandchild and do anything the sandbox allows.
        const privilege = privilegeCheck(pre.parentId, kind, pre.parent)
        if (!privilege.allowed) {
          log(`delegate REFUSED escalation: ${privilege.callerKind} child asked for ${kind}`)
          if (!wait) throw new Error(privilege.message)
          return {
            kind: 'activation',
            name: requestedName,
            status: 'denied',
            summary: summarize(privilege.message),
            denials: [{ tool: 'delegate', code: 'PRIVILEGE_ESCALATION' }],
            usage: zeroUsage(),
            ...withModel,
            elapsedMs: spent(),
          }
        }

        // An explicitly selected model (including an effort-only request) is
        // authorized against the OFFICIAL subagent model-selection switch first,
        // then validated against the provider catalog, so a refusal answers with
        // the switch that is off or with the available choices — never with a
        // provider error, and never after a child exists. Inheriting skips both:
        // the parent route is already a live selection.
        const selection = choice.agentOptions === undefined
          ? { ok: true }
          : await checkExplicitModelSelection(ctx, pre.parent.session, choice)
        if (!selection.ok) {
          log(`delegate REFUSED model (${selection.code}): ${selection.message}`)
          return {
            kind: 'activation',
            name: requestedName,
            status: 'denied',
            summary: summarize(selection.message),
            denials: [{ tool: 'delegate', code: selection.code }],
            usage: zeroUsage(),
            ...withModel,
            elapsedMs: spent(),
          }
        }
        if (choice.model !== undefined) {
          const routeCheck = await checkModelRoute(ctx, choice.model)
          if (!routeCheck.ok) {
            log(`delegate REFUSED model route: ${routeCheck.message}`)
            return {
              kind: 'activation',
              name: requestedName,
              status: 'error',
              summary: summarize(routeCheck.message),
              denials: [],
              usage: zeroUsage(),
              ...withModel,
              elapsedMs: spent(),
            }
          }
        }

        // P0-1: a child is never left to the runtime's `agent-N`. An explicit
        // name wins; otherwise one is derived from the task and kept unique
        // inside this session (`-2`, `-3`, …), so the topology stays readable without the model inventing names.
        const dispatchName = named ?? uniqueChildName(pre.parentId, task)
        rememberChildName(pre.parentId, dispatchName)
        // P1-6: the same task text from this parent inside the duplicate window
        // is still dispatched, but its result names the earlier run. LOOK UP
        // only; the fingerprint is recorded after the child actually starts, so
        // a refusal or a failed start cannot poison the caller's corrected retry.
        const duplicateOf = findDuplicate(pre.parentId, task)

        let started
        try {
          started = await startChild(ctx, {
            parentId: pre.parentId,
            parent: pre.parent,
            subagents: pre.subagents,
            providerName: pre.providerName,
            task,
            kind,
            name: dispatchName,
            scope: args?.scope,
            agentOptions: choice.agentOptions,
            signal: exec?.signal,
            isolate,
            skills: args?.skills === true,
            toolsProfile: kind === 'write' ? toolsProfile : undefined,
          })
        } catch (error) {
          const message = String(error?.message ?? error)
          // A write-scope refusal is a policy decision, not a broken provider:
          // report it the same way for wait:true and wait:false so the caller
          // always sees the code and who owns the conflicting paths.
          //   - WRITE_SCOPE_OVERLAP: another child holds the paths;
          //   - WRITE_SCOPE_INVALID: the declared scope is outside the workspace
          //     (M7 — it used to be silently widened to the whole tree).
          if (error?.code === 'WRITE_SCOPE_OVERLAP' || error?.code === 'WRITE_SCOPE_INVALID') {
            log(`delegate REFUSED write scope (${error.code}): ${message}`)
            return {
              kind: 'activation',
              name: requestedName,
              status: 'denied',
              summary: summarize(message),
              denials: [{ tool: 'delegate', code: error.code }],
              usage: zeroUsage(),
              ...withModel,
              elapsedMs: spent(),
            }
          }
          log(`delegate FAILED (kind=${kind}): ${message}`)
          // Say what the caller can act on: retrying the same call is useless when
          // the pool or the depth budget is what refused it.
          if (!wait) {
            throw new Error(
              'delegate could not start a child (no free subagent slot, depth budget exhausted, '
              + 'or the provider rejected it): ' + message,
            )
          }
          const depth = /depth/i.test(message)
          return {
            kind: 'activation',
            name: requestedName,
            status: depth ? 'depth-exhausted' : 'error',
            summary: summarize(
              `delegate could not start a child (${depth ? 'delegation depth budget exhausted' : 'provider rejected it'}): ${message}`,
            ),
            denials: [],
            usage: zeroUsage(),
            ...withModel,
            elapsedMs: spent(),
          }
        }

        const name = String(started?.name ?? dispatchName)
        const childId = childIdOf(started)
        // The child exists now, so the duplicate fingerprint becomes real: a
        // refusal or a failed start never reaches this line.
        rememberDuplicate(pre.parentId, task, name, duplicateOf)
        // P0-3: register the run BEFORE waiting, so the topology sidebar shows it
        // while it is still running (and after a `wait:false` return).
        registerRun(ctx, {
          childId,
          name,
          parentId: pre.parentId,
          rootId: runRootOf(ctx, pre.parent?.session?.header, pre.parentId),
          model: withModel.model,
          startedAt,
          kind,
          worktreeBranch: worktreeResultFields(childId)?.worktree?.branch ?? '',
        })
        log(
          `delegate: kind=${kind} -> ${name} (child=${childId ?? '?'}, wait=${wait}, model=${withModel.model}`
          + `${isolate ? ', isolate=true' : ''}${kind === 'write' ? `, tools=${toolsProfile.mode}` : ''}`
          + `, timeoutAction=${timeoutAction}${maxRuntimeMs > 0 ? `, maxRuntimeMs=${maxRuntimeMs}` : ''}`,
        )

        // `maxRuntimeMs` caps the CHILD, not this call: it must fire for
        // `wait:false` too (that child outlives the tool call entirely), so it is
        // armed here and disarmed by the activation result promise; the wait path
        // additionally disarms it after a settlement that is not a timeout.
        const stopRuntimeCap = startRuntimeCap(ctx, exec?.agent, childId, name, maxRuntimeMs, started)
        // wait=false keeps the historical contract, plus the resolved model,
        // (Tier 3) the worktree it was started on, the child session, and the
        // duplicate note. The run's `result` promise is still OBSERVED: an
        // infrastructure rejection must not become an unhandledRejection just
        // because nobody in this process awaits the detached child.
        if (!wait) {
          watchDetachedResult(started, childId, name)
          return withDuplicateNote({
            kind: 'activation',
            name,
            ...(childId === undefined ? {} : { child: childId }),
            ...withModel,
            ...worktreeResultFields(childId),
            ...(ignoredNotes.length === 0 ? {} : { summary: summarize(ignoredNotes.join(' · ')) }),
          }, duplicateOf)
        }

        // The runtime cap is disarmed right after the settlement — unless the
        // call DETACHED, because a timeout keeps the child running and the cap
        // belongs to the child, not to this call. A `wait:false` return above
        // never reaches this point (its timer is disarmed by the activation
        // result instead).
        const settled = await settleChild(ctx, {
          started,
          childId,
          name,
          kind,
          model: choice.model,
          budgetMs,
          signal: exec?.signal,
          startedAt,
          // Only the caller can stop an EXTERNAL child (parent abort,
          // `timeoutAction=interrupt`): the host admits an exact live ancestor.
          agent: exec?.agent,
          timeoutAction,
        })
        if (settled.status !== 'timeout') stopRuntimeCap()
        // The settled row refines the running one: real status, real tokens,
        // the provider-reported model and the worktree branch — EXCEPT on a
        // timeout, which is a WAIT cap and not a verdict: the child is still
        // running and still owns its lease, so the entry stays running and only
        // the refined fields are merged. `subagent/end` publishes the real end.
        const runFields = {
          model: settled.model,
          worktreeBranch: settled.worktree?.branch ?? (childWorktrees.get(String(childId))?.branch ?? ''),
        }
        if (settled.status === 'timeout') {
          updateRun(childId, runFields)
        } else {
          updateRun(childId, {
            ...runFields,
            status: settled.status,
            endedAt: Date.now(),
            tokens: Number(settled.usage?.totalTokens ?? 0) || 0,
          })
        }
        const finalRow = withDuplicateNote(withNotes(settled, ignoredNotes), duplicateOf)
        // P1-5: one JSONL line per settled delegation; a write failure is logged
        // and swallowed, never surfaced as a tool error.
        appendRunRecord(exec?.agent, pre.parentId, finalRow)
        return finalRow
      },
    }))
    log('tool delegate registered')
  } catch (error) {
    log(`tool delegate FAILED: ${error?.message}`)
  }

  // `cancel_subagent(childId)` — the explicit stop for a detached child.
  //
  // `budgetMs` is a WAIT cap, so a timeout leaves the child running on purpose
  // (it may be a long writer) and a `wait:false` child outlives the call as
  // well. `send_message` resumes such a child; this tool is the way to STOP it.
  // The host call is synchronous, a silent no-op for a target that is not
  // resident, and a thrown UNAUTHORIZED unless the caller is the exact live
  // ancestor. Ancestry is checked here first for a readable answer; the host
  // stays the authority.
  try {
    ctx.effect(() => ctx.tools.register({
      name: 'cancel_subagent',
      description:
        'Stop a subagent this session delegated (the `child` id of a delegate result). '
        + 'Use it after a `delegate` budget timeout detached the child, or for a `wait:false` child. '
        + 'Only a descendant of this session can be cancelled; a child that already ended is a no-op, '
        + 'and its write lease is released when it actually ends.',
      parameters: {
        type: 'object',
        properties: {
          childId: {
            type: 'string',
            description: 'The child session id (`child` in the delegate result).',
          },
        },
        required: ['childId'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'cancel' },
            child: { type: 'string' },
            status: { type: 'string', enum: CANCEL_STATUSES },
            code: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['kind', 'child', 'status'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          try {
            const child = String(value?.child ?? '?')
            const status = String(value?.status ?? 'error')
            const code = typeof value?.code === 'string' && value.code !== '' ? ` [${value.code}]` : ''
            const lines = [`cancel_subagent ${child}: ${status}${code}`]
            if (typeof value?.summary === 'string' && value.summary.trim() !== '') {
              lines.push(clipText(value.summary, DISPLAY_TEXT_LIMIT))
            }
            return [{ type: 'text', text: lines.join('\n') }]
          } catch {
            return [{ type: 'text', text: 'cancel_subagent finished' }]
          }
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const childId = typeof args?.childId === 'string' ? args.childId.trim() : ''
        const shown = childId === '' ? '?' : childId
        const parent = exec?.agent
        const parentId = parent?.session?.header?.id
        const row = (status, summary, code) => ({
          kind: 'cancel',
          child: shown,
          status,
          ...(code === undefined ? {} : { code }),
          summary: summarize(summary),
        })
        try {
          if (childId === '') {
            return row('refused', 'cancel_subagent needs a non-empty `childId` (the `child` field of a delegate result)', 'MISSING_CHILD_ID')
          }
          if (parent === undefined || parentId === undefined) {
            return row('refused', 'cancel_subagent requires a calling agent', 'NO_AGENT')
          }
          if (String(parentId) === childId) {
            return row('refused', `child ${childId} is this session; a session cannot cancel itself`, 'UNAUTHORIZED')
          }
          if (!isDescendantSession(ctx, parentId, childId)) {
            return row('refused', `child ${childId} is not a descendant of this session; cancel_subagent only stops children this session started`, 'NOT_DESCENDANT')
          }
          // Liveness only LABELS the answer: an external child can be running
          // without being in `agents`, and the host no-ops for one that ended.
          const live = isLiveChild(ctx, childId)
          const stopped = requestInterrupt(ctx, parent, childId, 'cancel_subagent')
          if (!stopped.ok) {
            return row('error', `the host refused to stop child ${childId} (${stopped.code}): ${stopped.message}`, stopped.code)
          }
          return {
            kind: 'cancel',
            child: childId,
            status: live ? 'requested' : 'not-running',
            summary: summarize(
              live
                ? `stop requested for child ${childId}; its write lease is released when it actually ends`
                : `child ${childId} is not running (it already settled); nothing to stop`,
            ),
          }
        } catch (error) {
          const message = String(error?.message ?? error)
          log(`cancel_subagent FAILED: ${message}`)
          return row('error', `cancel_subagent failed: ${message}`, 'INTERNAL')
        }
      },
    }))
    log('tool cancel_subagent registered')
  } catch (error) {
    log(`tool cancel_subagent FAILED: ${error?.message}`)
  }

  // `delegate_many(tasks)` — the batch entry point. `delegate` is deliberately
  // serialized (the kind slot is single-slot per parent), so a batch would be
  // pointless if it queued. This tool serializes ONLY the kind-slot window via
  // the shared per-parent mutex and waits for every child in parallel; each task
  // is isolated, so one failure/denial/timeout never sinks the others.
  //
  // The one EXCEPTION is write-scope admission: `preflightBatchWriteLeases` runs
  // before the first child starts, intersects every write task's effective scope
  // with the running leases and with every other write task in the batch, and a
  // single overlap refuses the WHOLE batch atomically (`results: []`, no child
  // started) instead of producing a half-dispatched batch. Other per-task
  // problems (privilege, bad model, failed start) still affect only their row.
  try {
    ctx.effect(() => ctx.tools.register({
      name: 'delegate_many',
      description:
        'Delegate several self-contained tasks at once and wait for all of them; each task is one '
        + '`delegate` (same fields, same kind semantics). Up to maxConcurrent run at once and the '
        + 'rest queue; one failed, denied or timed-out row never sinks the others. Write tasks are '
        + 'admitted as a WHOLE before the first child starts: overlapping write scopes (or one '
        + 'overlapping a running child) refuse the entire batch atomically — status "denied", '
        + 'results [], nothing started — so give disjoint scopes or isolate:true. reconcile merges '
        + 'the usable answers, distills findings[] and judges real conflicts; it needs 2+ usable '
        + 'results. The per-task model fields follow the same official model-selection switch as '
        + '`delegate`: refused as a `denied` row while the switch is off, limited to its allowed '
        + 'models while it is on. wait:false starts everything and the answers arrive later as messages.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'One child per entry, order preserved; fields = delegate\'s.',
            items: {
              type: 'object',
              properties: {
                task: {
                  type: 'string',
                  description: 'Same as delegate.',
                },
                kind: {
                  type: 'string',
                  enum: ['read', 'write', 'verify'],
                  description: 'Same as delegate.',
                },
                name: {
                  type: 'string',
                  description: 'Same as delegate.',
                },
                scope: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Same as delegate.',
                },
                isolate: {
                  type: 'boolean',
                  default: false,
                  description: 'Same as delegate.',
                },
                skills: {
                  type: 'boolean',
                  default: false,
                  description: 'Same as delegate.',
                },
                tools: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' } },
                  ],
                  description: 'Same as delegate.',
                },
                model: {
                  type: 'string',
                  description: 'Same as delegate.',
                },
                provider: {
                  type: 'string',
                  description: 'Same as delegate.',
                },
                reasoningEffort: {
                  type: 'string',
                  description: 'Same as delegate.',
                },
              },
              required: ['task'],
              additionalProperties: false,
            },
          },
          maxConcurrent: {
            type: 'number',
            default: DEFAULT_CONCURRENCY,
            description: `At once (${MIN_CONCURRENCY}..${MAX_CONCURRENCY}, default ${DEFAULT_CONCURRENCY}); the rest queue.`,
          },
          wait: {
            type: 'boolean',
            default: true,
            description: 'Same as delegate.',
          },
          budgetMs: {
            type: 'number',
            default: DEFAULT_BUDGET_MS,
            description: 'Per-task wait cap; also the batch deadline.',
          },
          reconcile: {
            type: 'boolean',
            default: false,
            description: 'Needs 2+ usable results; never fails the batch.',
          },
          reconcileQuestion: {
            type: 'string',
            description: 'The question the batch answers (reconcile).',
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'batch' },
            // Atomic write-scope refusal: the WHOLE batch was refused before any
            // child started. Only then is `status`/`summary`/`denials` present,
            // with `results: []` and every count at 0.
            status: { type: 'string', enum: STATUSES },
            summary: { type: 'string' },
            denials: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tool: { type: 'string' },
                  code: { type: 'string' },
                },
                required: ['tool', 'code'],
                additionalProperties: false,
              },
            },
            total: { type: 'number' },
            counts: {
              type: 'object',
              properties: {
                ok: { type: 'number' },
                partial: { type: 'number' },
                denied: { type: 'number' },
                error: { type: 'number' },
                timeout: { type: 'number' },
                interrupted: { type: 'number' },
                'depth-exhausted': { type: 'number' },
                running: { type: 'number' },
              },
              additionalProperties: false,
            },
            totalTokens: { type: 'number' },
            elapsedMs: { type: 'number' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'number' },
                  ...activationResultProperties(),
                },
                required: ['index', 'kind', 'name'],
                additionalProperties: false,
              },
            },
            merged: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            // Structured distillation from the same synthesis child. Always an
            // array: an unparsable answer yields [], never a missing field.
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  claim: { type: 'string' },
                  evidence: { type: 'array', items: { type: 'string' } },
                },
                required: ['claim', 'evidence'],
                additionalProperties: false,
              },
            },
            conflicts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  a: { type: 'number' },
                  b: { type: 'number' },
                  reason: { type: 'string' },
                  verdict: { type: 'string', enum: JUDGE_VERDICTS },
                  verdictReason: { type: 'string' },
                },
                required: ['a', 'b', 'reason', 'verdict', 'verdictReason'],
                additionalProperties: false,
              },
            },
            error: { type: 'string' },
          },
          required: ['kind', 'results'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          try {
            const results = Array.isArray(value?.results) ? value.results : []
            const lines = [
              `batch: ${Number(value?.total ?? results.length)} task(s) in ${Number(value?.elapsedMs ?? 0)}ms`,
            ]
            if (value?.counts !== undefined && value.counts !== null) {
              const counts = Object.entries(value.counts)
                .map(([status, count]) => `${status}=${count}`)
                .join(', ')
              if (counts !== '') lines.push(`counts: ${counts}`)
            }
            if (typeof value?.totalTokens === 'number') lines.push(`tokens: ${value.totalTokens}`)
            // How many rows carry a context warning, so one glance answers
            // "did anything here run out of room?" without reading every row.
            const warned = results.filter(result => typeof result?.contextWarning === 'string'
              && result.contextWarning !== '').length
            if (warned > 0) lines.push(`ctx warnings: ${warned}/${results.length}`)
            if (typeof value?.merged === 'string' && value.merged.trim() !== '') {
              lines.push(`merged: ${clipText(value.merged, 600)}`)
            }
            if (Array.isArray(value?.findings) && value.findings.length > 0) {
              for (const finding of value.findings) {
                const evidence = Array.isArray(finding?.evidence) && finding.evidence.length > 0
                  ? ` — ${finding.evidence.join(', ')}`
                  : ''
                lines.push(`finding: ${clipText(finding?.claim ?? '', 200)}${evidence}`)
              }
            }
            if (Array.isArray(value?.conflicts) && value.conflicts.length > 0) {
              for (const conflict of value.conflicts) {
                lines.push(
                  `conflict #${conflict?.a ?? '?'} vs #${conflict?.b ?? '?'}: ${String(conflict?.verdict ?? '?')}`
                  + `${typeof conflict?.reason === 'string' && conflict.reason !== '' ? ` — ${conflict.reason}` : ''}`,
                )
              }
            }
            if (typeof value?.error === 'string' && value.error !== '') lines.push(`error: ${value.error}`)
            const shown = results.slice(0, RENDER_LIMIT)
            for (const result of shown) {
              lines.push(
                `#${result?.index ?? '?'} ${result?.name ?? '?'}: ${result?.status ?? '?'} `
                + `(${Number(result?.elapsedMs ?? 0)}ms)${describeRoute(result)}${describeContextBadge(result)}${describeWorktreeBadge(result)}${describeDuplicate(result)}`,
              )
              // Each row's own reason, capped so twelve of them cannot flood the
              // card; a failed row without it is unreadable.
              if (typeof result?.summary === 'string' && result.summary.trim() !== '') {
                lines.push(`  ${clipText(result.summary, DISPLAY_TEXT_LIMIT)}`)
              }
              const worktreeError = describeWorktreeError(result)
              if (worktreeError !== undefined) lines.push(`  ${worktreeError}`)
              const contextWarning = describeContextWarning(result)
              if (contextWarning !== undefined) lines.push(`  ${contextWarning}`)
              const denials = describeDenials(result?.denials)
              if (denials !== undefined) lines.push(`  ${denials}`)
            }
            if (results.length > shown.length) lines.push(`… ${results.length - shown.length} more task(s)`)
            return [{ type: 'text', text: lines.join('\n') }]
          } catch {
            return [{ type: 'text', text: 'delegate_many finished' }]
          }
        },
      },
      // Parallel-safe like `delegate`: the batch runs its own worker pool, its
      // write leases are admitted in one synchronous block (check-before-reserve
      // has no await in between), and the only per-parent slot it touches goes
      // through `withKindSlot`. Its wait — the whole point of the call — must not
      // be serialized against a sibling batch.
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const startedAt = Date.now()
        const spent = () => Date.now() - startedAt
        const wait = args?.wait !== false
        const budgetMs = clampBudget(args?.budgetMs)
        // Whole-batch deadline: queued tasks only get what is left of it, so the
        // batch call itself never outlives budgetMs.
        const deadline = startedAt + budgetMs
        const maxConcurrent = clampConcurrency(args?.maxConcurrent)
        const signal = exec?.signal
        const tasks = Array.isArray(args?.tasks) ? args.tasks : []
        const results = new Array(tasks.length)
        const batchError = Array.isArray(args?.tasks)
          ? (args.tasks.length === 0 ? 'delegate_many requires at least one task' : undefined)
          : 'delegate_many requires a `tasks` array'

        let pre
        let preflightError
        try {
          pre = preflight(ctx, exec)
        } catch (error) {
          preflightError = String(error?.message ?? error)
          log(`delegate_many PREFLIGHT FAILED: ${preflightError}`)
        }
        const fatal = batchError ?? preflightError

        // P0-1 / P1-6 for the whole batch, computed ONCE up front: the derived
        // names are deterministic (task order, not completion order) and each
        // one is unique inside this session. Only the duplicate LOOKUP happens
        // here; the fingerprint is recorded by each row once its child really
        // started, so an atomic refusal leaves no trace and a retry is not
        // reported as a duplicate of a run that never existed.
        const derivedNames = new Array(tasks.length)
        const duplicateOf = new Array(tasks.length)
        if (fatal === undefined) {
          for (let index = 0; index < tasks.length; index += 1) {
            try {
              const spec = tasks[index]
              if (spec === null || typeof spec !== 'object') continue
              const explicit = acceptableChildName(spec.name)
              if (explicit === undefined && typeof spec.name === 'string' && spec.name.trim() !== '') {
                log(`delegate_many[${index}]: name ${JSON.stringify(clipText(spec.name, 80))} is not usable (1..64 chars of letters/digits/._-); using a derived name`)
              }
              const name = explicit ?? uniqueChildName(pre.parentId, spec.task)
              rememberChildName(pre.parentId, name)
              derivedNames[index] = name
              if (typeof spec.task === 'string' && spec.task.trim() !== '') {
                duplicateOf[index] = findDuplicate(pre.parentId, spec.task)
              }
            } catch (error) {
              log(`delegate_many[${index}] naming FAILED: ${error?.message}`)
            }
          }
        }

        // 原子预检（先于任何子代理）：整批的写域一次性算完并求交。批次内部两两
        // 求交 + 与已在运行的租约求交；任何一处重叠 ⇒ 整批拒绝、一个都不启动。
        // 通过时把整批租约一次性登记好，再交给 worker 池去启动（启动失败由
        // runOne 的收尾按现有 releaseWriteLease 路径回滚）。
        const batchReservations = new Array(tasks.length)
        if (fatal === undefined && tasks.length > 0) {
          let admitted
          try {
            admitted = preflightBatchWriteLeases(ctx, pre.parentId, pre.parent, tasks, derivedNames)
          } catch (error) {
            log(`delegate_many: preflight lease check FAILED (unexpected): ${error?.message}`)
            admitted = { ok: true, reservations: [] }
          }
          if (admitted?.ok === false) {
            const message = typeof admitted.message === 'string' && admitted.message !== ''
              ? admitted.message
              : 'write scope conflict rejected the whole batch before any child started'
            log(`delegate_many: batch REJECTED atomically before start: total=${tasks.length} agentsStarted=0`)
            // 写域冲突是整批级的拒绝：results 为空（没有任何子代理启动），
            // counts 全 0，denials 一条 WRITE_SCOPE_OVERLAP。其它问题仍只影响
            // 各自那一行，永远走不到这里。
            return {
              kind: 'batch',
              status: 'denied',
              total: tasks.length,
              counts: zeroCounts(),
              totalTokens: 0,
              elapsedMs: spent(),
              results: [],
              summary: summarize(message),
              denials: [{ tool: 'delegate_many', code: 'WRITE_SCOPE_OVERLAP' }],
              merged: null,
              findings: [],
              conflicts: [],
              error: summarize(message),
            }
          }
          for (const entry of admitted?.reservations ?? []) {
            try {
              if (entry === undefined || entry.reservation === undefined) continue
              const index = Number(entry.index)
              if (!Number.isInteger(index) || index < 0 || index >= batchReservations.length) continue
              batchReservations[index] = entry.reservation
            } catch (error) {
              log(`delegate_many: preflight reservation bind FAILED: ${error?.message}`)
            }
          }
        }

        /** A task that never produced a child-level result. Never throws. */
        const failedItem = (index, spec, status, message, denials, model) => ({
          index,
          kind: 'activation',
          name: typeof derivedNames[index] === 'string' && derivedNames[index] !== ''
            ? derivedNames[index]
            : (typeof spec?.name === 'string' && spec.name !== '' ? spec.name : deriveChildName(spec?.task)),
          status,
          summary: summarize(message),
          denials: denials ?? [],
          usage: zeroUsage(),
          ...(typeof model === 'string' && model !== '' ? { model } : {}),
          elapsedMs: spent(),
        })

        /** One task: privilege → serialized start → isolated parallel wait. */
        const runOneCore = async (index, spec) => {
          const taskStartedAt = Date.now()
          const requestedName = typeof derivedNames[index] === 'string' && derivedNames[index] !== ''
            ? derivedNames[index]
            : (typeof spec?.name === 'string' && spec.name !== '' ? spec.name : deriveChildName(spec?.task))
          const localSpent = () => Date.now() - taskStartedAt
          let withModel = { model: 'inherit' }
          try {
            // Model selection is per task and independent of `kind`; the same
            // parser, the same official-switch gate and the same route
            // validation as `delegate`.
            const choice = parseModelChoice(spec)
            if (!choice.ok) {
              log(`delegate_many[${index}] REFUSED model: ${choice.message}`)
              return failedItem(index, spec, 'error', `delegate_many: ${choice.message}`)
            }
            withModel = { model: choice.model ?? 'inherit' }

            const selection = choice.agentOptions === undefined
              ? { ok: true }
              : await checkExplicitModelSelection(ctx, pre.parent.session, choice)
            if (!selection.ok) {
              log(`delegate_many[${index}] REFUSED model (${selection.code}): ${selection.message}`)
              return failedItem(index, spec, 'denied', `delegate_many: ${selection.message}`,
                [{ tool: 'delegate_many', code: selection.code }], withModel.model)
            }

            if (typeof spec?.task !== 'string' || spec.task.trim() === '') {
              return failedItem(index, spec, 'error', 'delegate_many: every task needs a non-empty string `task`', undefined, withModel.model)
            }
            if (signal?.aborted === true) {
              return {
                index,
                kind: 'activation',
                name: requestedName,
                status: 'interrupted',
                summary: summarize('delegate_many: the call was aborted before this child started'),
                denials: [],
                usage: zeroUsage(),
                ...withModel,
                elapsedMs: localSpent(),
              }
            }

            const kind = normalizeKind(spec?.kind)
            // Tier 3 is per task and, like `delegate`, ignored for a reader or
            // verifier — whose row then says so in its summary.
            const isolate = spec?.isolate === true
            const isolateNote = isolate && kind !== 'write' ? ISOLATE_IGNORED_NOTE : undefined
            if (isolateNote !== undefined) log(`delegate_many[${index}]: ${isolateNote} (kind=${kind})`)
            // Same contract as `delegate`: a writer may pick its tool set, a
            // reader/verifier ignores `tools` and the row says so.
            const toolsProfile = resolveToolsProfile(spec?.tools, ` (delegate_many[${index}])`)
            const toolsNote = kind !== 'write' && spec?.tools !== undefined ? TOOLS_IGNORED_NOTE : undefined
            if (toolsNote !== undefined) log(`delegate_many[${index}]: ${toolsNote} (kind=${kind})`)
            const ignoredNotes = [isolateNote, toolsNote].filter(note => note !== undefined)
            // Per-task privilege: a refused task is one "denied" row, never a
            // failed batch.
            const privilege = privilegeCheck(pre.parentId, kind, pre.parent)
            if (!privilege.allowed) {
              log(`delegate_many REFUSED escalation: ${privilege.callerKind} child asked for ${kind}`)
              return {
                index,
                kind: 'activation',
                name: requestedName,
                status: 'denied',
                summary: summarize(privilege.message),
                denials: [{ tool: 'delegate', code: 'PRIVILEGE_ESCALATION' }],
                usage: zeroUsage(),
                ...withModel,
                elapsedMs: localSpent(),
              }
            }

            // A selected route is authorized like `delegate`'s (switch, allowlist) and
            // then validated against the catalog: one bad row, with the available
            // choices, never a failed batch.
            if (choice.model !== undefined) {
              const routeCheck = await checkModelRoute(ctx, choice.model)
              if (!routeCheck.ok) {
                log(`delegate_many[${index}] REFUSED model route: ${routeCheck.message}`)
                return failedItem(index, spec, 'error', `delegate_many: ${routeCheck.message}`, undefined, withModel.model)
              }
            }

            let started
            try {
              started = await startChild(ctx, {
                parentId: pre.parentId,
                parent: pre.parent,
                subagents: pre.subagents,
                providerName: pre.providerName,
                task: spec.task,
                kind,
                name: typeof derivedNames[index] === 'string' ? derivedNames[index] : undefined,
                scope: spec?.scope,
                agentOptions: choice.agentOptions,
                signal,
                isolate,
                skills: spec?.skills === true,
                toolsProfile: kind === 'write' ? toolsProfile : undefined,
                // Registered by the batch preflight; `startChild` uses it as-is
                // instead of running its own check against our own siblings.
                reservation: batchReservations[index],
              })
            } catch (error) {
              const message = String(error?.message ?? error)
              // Tier 1 refusal: one "denied" row, the rest of the batch continues.
              // WRITE_SCOPE_INVALID (scope outside the workspace) is the same kind
              // of per-task policy refusal and must not fail its siblings.
              if (error?.code === 'WRITE_SCOPE_OVERLAP' || error?.code === 'WRITE_SCOPE_INVALID') {
                log(`delegate_many[${index}] REFUSED write scope (${error.code}): ${message}`)
                return {
                  index,
                  kind: 'activation',
                  name: requestedName,
                  status: 'denied',
                  summary: summarize(message),
                  denials: [{ tool: 'delegate', code: error.code }],
                  usage: zeroUsage(),
                  ...withModel,
                  elapsedMs: localSpent(),
                }
              }
              const depth = /depth/i.test(message)
              log(`delegate_many child start FAILED (kind=${kind}): ${message}`)
              return {
                index,
                kind: 'activation',
                name: requestedName,
                status: depth ? 'depth-exhausted' : 'error',
                summary: summarize(
                  `delegate_many could not start a child (${depth ? 'delegation depth budget exhausted' : 'no free slot, or the provider rejected it'}): ${message}`,
                ),
                denials: [],
                usage: zeroUsage(),
                ...withModel,
                elapsedMs: localSpent(),
              }
            }

            const name = String(started?.name ?? requestedName)
            const childId = childIdOf(started)
            // The child exists now: commit this row's duplicate fingerprint.
            rememberDuplicate(pre.parentId, spec.task, name, duplicateOf[index])
            // P0-3: a batch child is registered the same way as a single one.
            registerRun(ctx, {
              childId,
              name,
              parentId: pre.parentId,
              rootId: runRootOf(ctx, pre.parent?.session?.header, pre.parentId),
              model: withModel.model,
              startedAt: taskStartedAt,
              kind,
              worktreeBranch: worktreeResultFields(childId)?.worktree?.branch ?? '',
            })
            log(`delegate_many[${index}]: kind=${kind} -> ${name} (child=${childId ?? '?'}, wait=${wait}, model=${withModel.model}${kind === 'write' ? `, tools=${toolsProfile.mode}` : ''})`)

            if (!wait) {
              watchDetachedResult(started, childId, name)
              return {
                index,
                kind: 'activation',
                name,
                ...(childId === undefined ? {} : { child: childId }),
                status: 'running',
                summary: summarize(
                  `child ${name} started; its answer will arrive later as a message`
                  + (ignoredNotes.length === 0 ? '' : ` · ${ignoredNotes.join(' · ')}`),
                ),
                denials: [],
                usage: zeroUsage(),
                ...withModel,
                ...worktreeResultFields(childId),
                elapsedMs: localSpent(),
              }
            }

            // Out of batch budget: the child is already running, so report the
            // timeout and let it continue rather than killing started work.
            const remaining = deadline - Date.now()
            if (remaining <= 0) {
              return {
                index,
                kind: 'activation',
                name,
                ...(childId === undefined ? {} : { child: childId }),
                status: 'timeout',
                summary: summarize(
                  `child ${name} was started, but the batch budget (${budgetMs}ms) ran out before it settled; it may still be running (its answer will arrive as a message)`,
                ),
                denials: [],
                usage: zeroUsage(),
                ...withModel,
                ...worktreeResultFields(childId),
                elapsedMs: localSpent(),
              }
            }

            const settled = await settleChild(ctx, {
              started,
              childId,
              name,
              kind,
              model: choice.model,
              budgetMs: Math.min(budgetMs, remaining),
              signal,
              startedAt: taskStartedAt,
            })
            updateRun(childId, {
              status: settled.status,
              endedAt: Date.now(),
              tokens: Number(settled.usage?.totalTokens ?? 0) || 0,
              model: settled.model,
              worktreeBranch: settled.worktree?.branch ?? (childWorktrees.get(String(childId))?.branch ?? ''),
            })
            return withNotes({ index, ...settled }, ignoredNotes)
          } catch (error) {
            const message = String(error?.message ?? error)
            log(`delegate_many task ${index} FAILED: ${message}`)
            return failedItem(index, spec, 'error', `delegate_many task failed: ${message}`, undefined, withModel.model)
          }
        }

        /**
         * One task, plus the batch-lease rollback for a task that never started.
         *
         * The preflight registered EVERY batch lease before the first start, so a
         * task that returns early (bad model/task, privilege refusal, abort) or
         * whose activation throws must not leave its provisional lease behind.
         * A promoted reservation already belongs to a live child (released by
         * `subagent/end`); `releaseWriteLease` is the existing cleanup path and
         * is a no-op once the key is gone.
         */
        const runOne = async (index, spec) => {
          try {
            return await runOneCore(index, spec)
          } finally {
            try {
              const reservation = batchReservations[index]
              if (reservation !== undefined && reservation.promoted !== true) {
                releaseWriteLease(reservation.key, 'batch task did not start')
              }
            } catch (error) {
              log(`delegate_many[${index}] lease rollback FAILED: ${error?.message}`)
            }
          }
        }

        // Reconciliation never starts before every task settled, so its result
        // can be folded into the single answer below. Defaults are the
        // "reconcile off / nothing to merge" values, so an early failure path
        // still returns the documented fields.
        const reconciled = { merged: null, findings: [], conflicts: [] }

        /** Counts and totals over whatever the workers produced. Never throws. */
        const answer = () => {
          const counts = {}
          let totalTokens = 0
          for (const result of results) {
            const status = String(result?.status ?? 'error')
            counts[status] = (counts[status] ?? 0) + 1
            const tokens = Number(result?.usage?.totalTokens ?? 0)
            if (Number.isFinite(tokens)) totalTokens += tokens
          }
          return {
            kind: 'batch',
            total: results.length,
            ...(wait ? { counts, totalTokens } : {}),
            elapsedMs: spent(),
            results,
            merged: reconciled.merged,
            findings: reconciled.findings,
            conflicts: reconciled.conflicts,
            ...(fatal === undefined ? {} : { error: summarize(fatal) }),
          }
        }

        try {
          if (fatal !== undefined) {
            for (let index = 0; index < tasks.length; index += 1) {
              results[index] = failedItem(index, tasks[index], 'error', `delegate_many could not run: ${fatal}`)
            }
          } else if (tasks.length > 0) {
            // Worker pool: `slots` tasks are in flight; each worker starts one
            // child (mutex-serialized) and then waits for it without blocking
            // the other workers, so the waits genuinely overlap.
            let cursor = 0
            const worker = async () => {
              while (true) {
                const index = cursor
                cursor += 1
                if (index >= tasks.length) return
                try {
                  results[index] = withDuplicateNote(await runOne(index, tasks[index]), duplicateOf[index])
                } catch (error) {
                  results[index] = withDuplicateNote(failedItem(
                    index,
                    tasks[index],
                    'error',
                    `delegate_many task crashed: ${String(error?.message ?? error)}`,
                  ), duplicateOf[index])
                }
              }
            }
            const slots = Math.max(MIN_CONCURRENCY, Math.min(maxConcurrent, tasks.length))
            const workers = []
            for (let slot = 0; slot < slots; slot += 1) workers.push(worker())
            try {
              await Promise.all(workers)
            } catch (error) {
              log(`delegate_many workers FAILED: ${error?.message}`)
            }
          }

          // No holes: every index always carries a result row.
          for (let index = 0; index < results.length; index += 1) {
            if (results[index] === undefined) {
              results[index] = failedItem(index, tasks[index], 'error', 'delegate_many: task produced no result')
            }
          }

          // P1-5: one JSONL line per SETTLED row. A `running` row has no result
          // yet, so writing it would only record a placeholder; failures here
          // are logged inside `appendRunRecord` and never fail the batch.
          for (const result of results) {
            if (result === undefined) continue
            if (String(result?.status ?? '') === 'running') continue
            appendRunRecord(exec?.agent, pre?.parentId, result)
          }

          // Optional aggregation. Everything below is isolated: a failure there
          // leaves merged=null / findings=[] / conflicts=[] and the batch still
          // succeeds.
          if (args?.reconcile === true) {
            if (!wait) {
              log('reconcile SKIPPED: wait=false returns before any task settles')
            } else if (fatal !== undefined) {
              log('reconcile SKIPPED: the batch could not run')
            } else {
              const question = typeof args?.reconcileQuestion === 'string' && args.reconcileQuestion.trim() !== ''
                ? args.reconcileQuestion.trim()
                : '（调用方没有提供总问题；请从各条结果的共同主题推断，并在 merged 里写明推断出的是什么问题）'
              const merged = await reconcileBatch(ctx, {
                parent: pre.parent,
                parentId: pre.parentId,
                subagents: pre.subagents,
                providerName: pre.providerName,
                results,
                question,
                deadline,
                signal,
              })
              reconciled.merged = merged.merged
              reconciled.findings = merged.findings
              reconciled.conflicts = merged.conflicts
            }
          }

          const value = answer()
          log(
            `delegate_many: total=${value.total} counts=${JSON.stringify(value.counts ?? {})} `
            + `tokens=${value.totalTokens ?? 0} elapsed=${value.elapsedMs}ms`,
          )
          return value
        } catch (error) {
          // Absolute backstop: delegate_many never throws an uncaught error.
          log(`delegate_many RESULT FAILED: ${String(error?.message ?? error)}`)
          return {
            kind: 'batch',
            total: 0,
            ...(wait ? { counts: {}, totalTokens: 0 } : {}),
            elapsedMs: spent(),
            results: [],
            merged: null,
            findings: [],
            conflicts: [],
            error: summarize(`delegate_many failed: ${String(error?.message ?? error)}`),
          }
        }
      },
    }))
    log('tool delegate_many registered')
  } catch (error) {
    log(`tool delegate_many FAILED: ${error?.message}`)
  }

  // `deliberate(topic, participants, rounds)` — a multi-participant discussion.
  //
  // Round 1 starts N read-only participants in parallel (independent stances).
  // Round 2 does NOT re-dispatch: it sends the other stances into the SAME child
  // and waits for that child's next `subagent/end` (see the section comment above
  // `runDeliberation` for the source-level mechanism and the fallback). The
  // parent then merges the final stances through one read-only synthesis child
  // and judges at most two real disagreements with the internal judge kernel.
  //
  // `isConcurrencySafe: false` because the tool is its own fan-out controller:
  // it already overlaps its participants internally, its round-2 sends share the
  // per-parent kind slot, and it spends N x (rounds + 1) requests — two of these
  // in flight at once is exactly the runaway cost this tool refuses to allow.
  try {
    ctx.effect(() => ctx.tools.register({
      name: 'deliberate',
      description:
        '多参与者、多轮讨论团：N 个只读子代理先各自独立给结论，再把彼此立场回灌给同一个子代理做第 2 轮'
        + '（续跑，不重派），最后由父代理合并成 consensus / disagreements。'
        + '用于真有争议、需要多方专业视角互相挑错的方案选择；'
        + '"读多个文件然后总结"这种不需要它——成本是 N×(rounds+1) 次请求，比直接批量读取更慢更贵。',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: '要讨论的问题（一句话）。',
          },
          participants: {
            type: 'number',
            default: DELIB_DEFAULT_PARTICIPANTS,
            description: `${DELIB_MIN_PARTICIPANTS}..${DELIB_MAX_PARTICIPANTS}，默认 ${DELIB_DEFAULT_PARTICIPANTS}；超上限直接拒绝。`,
          },
          rounds: {
            type: 'number',
            default: DELIB_DEFAULT_ROUNDS,
            description: `1..${DELIB_MAX_ROUNDS}，默认 ${DELIB_DEFAULT_ROUNDS}；1 = 只收独立立场，不做回灌。`,
          },
          budgetMs: {
            type: 'number',
            default: 180000,
            description: '每个参与者每次等待的上限（ms）；总时长上限 = budgetMs×rounds+60000。',
          },
          kind: {
            type: 'string',
            enum: ['read'],
            description: '只接受 "read"（v1 只读讨论）；传 write 会被拒绝并说明。',
          },
        },
        required: ['topic'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'deliberation' },
            status: { type: 'string', enum: ['ok', 'partial', 'error'] },
            rounds: { type: 'number' },
            // Participants whose round 2 was not executed because the call
            // deadline was already exhausted (kept apart from `rounds`, which
            // echoes the requested round count).
            roundsSkipped: { type: 'number' },
            participants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  round1: { type: 'string' },
                  round2: { type: 'string' },
                  status: { type: 'string' },
                },
                required: ['name', 'round1', 'round2', 'status'],
                additionalProperties: false,
              },
            },
            synthesis: {
              type: 'object',
              properties: {
                consensus: { type: 'string' },
                findings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      claim: { type: 'string' },
                      evidence: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['claim', 'evidence'],
                    additionalProperties: false,
                  },
                },
                disagreements: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      between: { type: 'array', items: { type: 'string' } },
                      point: { type: 'string' },
                      verdict: { type: 'string', enum: JUDGE_VERDICTS },
                      verdictReason: { type: 'string' },
                    },
                    required: ['between', 'point', 'verdict'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['consensus', 'findings', 'disagreements'],
              additionalProperties: false,
            },
            usage: {
              type: 'object',
              properties: { totalTokens: { type: 'number' } },
              required: ['totalTokens'],
              additionalProperties: false,
            },
            elapsedMs: { type: 'number' },
            // Present ONLY when round 2 could not be continued and was
            // re-dispatched instead (the result never pretends it was a resume).
            resumeUnsupported: { type: 'boolean' },
            // A refusal / degraded notice; the call itself still returns normally.
            error: { type: 'string' },
          },
          required: ['kind', 'status', 'rounds', 'participants', 'synthesis', 'usage', 'elapsedMs'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          try {
            const participants = Array.isArray(value?.participants) ? value.participants : []
            const lines = [
              `discussion: ${String(value?.status ?? '?')} · ${participants.length} 参与者 · `
              + `${Number(value?.rounds ?? 0)} 轮 · ${Number(value?.elapsedMs ?? 0)}ms · `
              + `${Number(value?.usage?.totalTokens ?? 0)} tokens`,
            ]
            for (const row of participants) {
              lines.push(`- ${String(row?.name ?? '?')} [${String(row?.status ?? '?')}]`)
              const shown = typeof row?.round2 === 'string' && row.round2 !== '' ? row.round2 : row?.round1
              if (typeof shown === 'string' && shown !== '') lines.push(`  ${clipText(shown, DISPLAY_TEXT_LIMIT)}`)
            }
            const consensus = typeof value?.synthesis?.consensus === 'string' ? value.synthesis.consensus : ''
            if (consensus !== '') lines.push('', `consensus: ${clipText(consensus, DISPLAY_TEXT_LIMIT * 2)}`)
            for (const pair of value?.synthesis?.disagreements ?? []) {
              const between = Array.isArray(pair?.between) ? pair.between.join(' vs ') : '?'
              lines.push(`分歧 ${between}: ${clipText(String(pair?.point ?? ''), DISPLAY_TEXT_LIMIT)} → ${String(pair?.verdict ?? '?')}`)
            }
            if (value?.resumeUnsupported === true) {
              lines.push('注意: 续跑不可用，第 2 轮已降级为重派（resumeUnsupported=true）')
            }
            if (typeof value?.error === 'string' && value.error !== '') {
              lines.push(`${value?.status === 'error' ? '错误' : '注意'}: ${value.error}`)
            }
            return [{ type: 'text', text: lines.join('\n') }]
          } catch {
            return [{ type: 'text', text: 'deliberation finished' }]
          }
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          return await runDeliberation(ctx, { args, exec })
        } catch (error) {
          // The kernel already has a backstop; this one exists so that a bug in
          // preparation (a throwing accessor, an unexpected service shape) still
          // returns a well-formed result instead of failing the tool call.
          const message = String(error?.message ?? error)
          log(`deliberate execute wrapper FAILED: ${message}`)
          return deliberationResult({ rounds: 0, participants: [], error: `deliberate 内部错误：${message}` })
        }
      },
    }))
    log('tool deliberate registered')
  } catch (error) {
    log(`tool deliberate FAILED: ${error?.message}`)
  }

  // Tier 2: one global guard enforces the write leases. It is registered in the
  // plugin's (global) scope, so it sees every tool call from every session and
  // its denial is monotonic — the model cannot retry around it. `guardWriteScope`
  // never throws and returns immediately when no lease is held, which is the
  // normal case for almost every call.
  try {
    ctx.effect(() => ctx.tools.guard(execution => guardWriteScope(ctx, execution)))
    log('write-scope guard registered')
  } catch (error) {
    log(`write-scope guard FAILED: ${error?.message}`)
  }

  // Gap 1 (hard gate): `isolate: true` installs the child's worktree LAZILY, at
  // its first `turn/start`, so the model's first write-class tool call can run
  // before the session cwd has moved — the write then lands in the parent's
  // checkout (measured on a live run). This GLOBAL `tools/pre-execute` waterfall
  // holds such a call until that child's own worktree promise settles, bounded
  // by WORKTREE_GATE_TIMEOUT_MS; a timeout, an abort, a failed creation, or no
  // pending worktree at all lets the call through in the original cwd — it must
  // never hang a child.
  //
  // The fast path is first and covers almost every call: not a write-class tool,
  // or no child is waiting anywhere (`worktreeReady` is empty), costs a couple of
  // comparisons. `awaitWorktreeReady` is fully guarded, so the wait can never
  // throw; `next()` is deliberately called OUTSIDE that guard, because swallowing
  // a downstream policy failure would let the call run anyway — a chain error
  // must keep its own meaning instead of being turned into an allow.
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const tool = typeof exec?.name === 'string' ? exec.name : ''
      if (worktreeReady.size !== 0 && WORKTREE_GATE_TOOLS.has(tool)) {
        try {
          await awaitWorktreeReady(exec)
        } catch (error) {
          // Unreachable by construction; kept so this listener can never be the
          // reason a tool call fails.
          log(`worktree gate FAILED (passing through): ${error?.message}`)
        }
      }
      return next()
    })
    log('worktree write gate registered')
  } catch (error) {
    log(`worktree write gate registration FAILED: ${error?.message}`)
  }

  // `list_agents` compaction. The registry runs `tools/post-execute` as a
  // scope-filtered waterfall over EVERY tool call, so the first guard is the
  // tool name: another tool costs one string compare and delegates untouched.
  // The listener never throws (a throwing listener would turn that call into an
  // error) and only ever replaces the model-facing text of a >12-row result.
  //
  // `next()` is invoked EXACTLY ONCE per call, and its promise is taken BEFORE
  // any other decision. Calling it a second time (the old `catch` fallback did
  // that whenever `chained` was still false on an unrelated throw) would run the
  // rest of the waterfall twice — with side effects — and could turn one tool
  // call into two results.
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec?.name !== 'list_agents') return next()
      let downstream
      try {
        downstream = await next()
      } catch (error) {
        log(`list_agents: downstream post-execute FAILED: ${error?.message}`)
        return { kind: 'accept' }
      }
      try {
        // `next()` already ran above, so every path below only INSPECTS its
        // answer — none of them may call it again.
        if (result?.isError === true) return downstream
        const parsed = listAgentsRowsOf(result)
        if (parsed === undefined || parsed.rows.length <= LIST_AGENTS_COMPACT_OVER) return downstream
        const rows = parsed.rows
        const text = compactListAgentsText(rows)
        // A listener further down may have blocked the call (`block`) or
        // replaced the structured value; both win, because a content-only
        // replacement cannot coexist with either.
        if (downstream?.kind !== 'accept') return downstream ?? { kind: 'accept' }
        if (Object.hasOwn(downstream, 'value')) return downstream
        log(
          `list_agents: compacted ${rows.length} rows -> ${text.length} chars`
          + `${parsed.unparsedLines === 0 ? '' : ` (${parsed.unparsedLines} unparsed text line(s))`}`,
        )
        return { ...downstream, content: [{ type: 'text', text }] }
      } catch (error) {
        log(`list_agents compaction FAILED: ${error?.message}`)
        // The chain already ran; return its unchanged answer, never `next()` again.
        return downstream ?? { kind: 'accept' }
      }
    })
    log('list_agents compaction registered')
  } catch (error) {
    log(`list_agents compaction registration FAILED: ${error?.message}`)
  }

  // Primary lease release: the child settled. `info.id` is the child session id,
  // the same id the lease is keyed by. A listener error must never escape, or
  // one delegation could break the settlement of others.
  try {
    ctx.on('subagent/end', (info) => {
      try {
        const id = info?.id
        if (id === undefined || id === null) return
        const key = String(id)
        releaseWriteLease(key, 'subagent/end')
        // The child cannot call a tool any more, so its fail-closed marker goes
        // with the lease; a later resume re-derives both from the durable record.
        unleasedWriters.delete(key)
        // Tier 3: a child that ends before its first turn can never trigger the
        // deferred creation, so its intent is settled here instead of hanging —
        // this is the ONLY place that can honestly judge "never started", because
        // it is the only one that knows the child will not speak any more.
        const intent = worktreeIntents.get(key)
        if (intent !== undefined) {
          if (intent.started !== true) {
            log(`worktree: child=${key} ended before its first turn; no worktree created`)
            settleWorktreeIntent(intent, {
              ok: false,
              error: 'the child ended before its first turn, so no worktree was created',
            })
          } else {
            // A creation already in flight can still answer, but nothing may
            // register a worktree for a child that no longer exists: superseding
            // makes that answer a retained checkout + a log line only.
            supersedeWorktreeIntent(key, 'the child ended before its worktree creation answered')
          }
        }
        // Tier 3 bookkeeping: the child can no longer report a result, so its
        // registration MOVES to the retained map instead of being dropped. The
        // checkout stays on disk, and the Tier 3 exemption must outlive the
        // lease: forgetting the path here let an ancestor "whole workspace" lease
        // deny writes inside a checkout the human can still inspect.
        const endedWorktree = childWorktrees.get(key)
        if (endedWorktree !== undefined) retainWorktree(key, endedWorktree, 'the child ended')
        childWorktrees.delete(key)
        childWorktreeErrors.delete(key)
        // The child cannot run another tool, so a gate promise nobody will ever
        // await is dropped with it (settle normally did it already).
        worktreeReady.delete(key)
        // P0-3: the lifecycle event is the ONE place a `wait:false` child (or a
        // timeout) becomes known as finished; the tool path refines the entry
        // with the real status/tokens once its own settle resolves.
        try {
          if (runs.has(key)) {
            const patch = { endedAt: Date.now() }
            const status = statusOfStopReason(info?.stopReason)
            if (status !== undefined) patch.status = status
            updateRun(key, patch)
          }
        } catch (error) {
          log(`runs: subagent/end update FAILED: ${error?.message}`)
        }
        // The manager disposes the child agent BEFORE emitting this event, so
        // its fiber-bound surface restriction is already lifted; drop the dead
        // disposer so a long-lived process does not accumulate them.
        surfaceDisposers.delete(key)
      } catch (error) {
        log(`write lease end handler FAILED: ${error?.message}`)
      }
    })
  } catch (error) {
    log(`subagent/end lease listener FAILED: ${error?.message}`)
  }

  // AGENT disposal (root template closed, child released): the session is gone,
  // so its surface entry can never be released again. The restriction itself is
  // owned by the disposed agent's fiber and has already been lifted by Cordis;
  // dropping the disposer here is map hygiene, and it keeps the switch from claiming it released a session that no longer exists.
  try {
    ctx.on('agent/disposed', (payload) => {
      try {
        const header = payload?.agent?.session?.header
        const id = header?.id ?? payload?.agent?.id
        if (id === undefined || id === null) return
        surfaceDisposers.delete(String(id))
      } catch (error) {
        log(`surface: agent/disposed cleanup FAILED: ${error?.message}`)
      }
    })
  } catch (error) {
    log(`surface: agent/disposed listener FAILED: ${error?.message}`)
  }

  // Tier 3 trigger: the deferred worktree creation fires on the child's FIRST
  // `turn/start` (falling back to `step/start`), because that is the earliest
  // point at which the child's Cordis fiber is active — the service's final
  // "enter the checkout" step calls `fiber.assertActive()` and `agent/created`
  // runs before the fiber exists, which raised
  // "cannot create effect on inactive context". The first step is only a model
  // request, so the cwd switch still lands before any tool call.
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const id = session?.header?.id
        if (id === undefined || id === null) return
        const intent = worktreeIntents.get(String(id))
        if (intent === undefined || intent.started === true) return
        if (event?.type !== 'turn/start' && event?.type !== 'step/start') return
        fireWorktreeIntent(ctx, intent)
      } catch (error) {
        log(`worktree: turn trigger FAILED: ${error?.message}`)
      }
    })
  } catch (error) {
    log(`worktree: session/event listener FAILED: ${error?.message}`)
  }

  // Prime the team cache: a plugin reload clears it, and `agent/created` never
  // re-fires for sessions that already exist, which would silently downgrade the
  // official switch to "off" until somebody toggles it again.
  //
  // The SAME reload gap applies to the delegation surface: those sessions were
  // converged in an earlier process, so they must be converged here or never.
  // Each agent gets its own try/catch — one unreadable session cannot stop the
  // others and nothing here may reject `apply()`.
  try {
    const team = ctx.get('agentTeams')
    const agents = ctx.get('agents')
    if (team !== undefined && typeof team.isEnabled === 'function' && typeof agents?.list === 'function') {
      let primed = 0
      for (const candidate of agents.list() ?? []) {
        const header = candidate?.session?.header
        if (header === undefined) continue
        if (typeof header.id !== 'string' || header.id === '') continue
        const id = header.id
        // A LIVE subagent outlived the reload too. Its kind/tools/skills were
        // applied by the previous process (and those restrictions are still in
        // force), but a child born before this plugin was loaded — or one whose
        // creation trim threw — would otherwise never be converged. Replay the
        // durable records; never append a record from here.
        if (header.origin === 'subagent') {
          try {
            replayChildSurface(ctx, candidate, candidate.session, header, id)
          } catch (error) {
            log(`surface: prime FAILED for child session=${id}: ${error?.message}`)
          }
          continue
        }
        try {
          teamDecision.set(id, team.isEnabled(candidate) === true)
          primed += 1
        } catch (error) {
          /* a session without a live runtime cannot be probed yet */
        }
        // Re-publish an explicit choice made before this plugin load, so the
        // model-menu switch shows the saved value immediately.
        const primedState = readState()[id]
        if (primedState !== undefined) {
          recordGateOnce(candidate.session, primedState.enabled === true)
            .catch(error => log(`gate: prime record FAILED for session=${id}: ${error?.message}`))
        }
        try {
          const gate = gateFor(header, id)
          if (!gate.on) {
            log(`surface: skipped for session=${id} (primed, gate=${gate.source})`)
          } else {
            restrictDelegationSurface(candidate, id, 'primed')
          }
        } catch (error) {
          log(`surface: prime FAILED for session=${id}: ${error?.message}`)
        }
      }
      log(`team cache primed: ${primed} root session(s)`)
    }
  } catch (error) {
    log(`team cache prime FAILED: ${error?.message}`)
  }

  // Keep the cached official switch current: `setEnabled` appends `team/mode`.
  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'team/mode') return
      try {
        const id = session?.header?.id
        if (id === undefined) return
        teamDecision.set(id, event.data?.enabled === true)
        log(`team/mode -> ${String(event.data?.enabled)} for session=${id}`)
      } catch (error) {
        log(`team/mode handler FAILED: ${error?.message}`)
      }
    })
  } catch (error) {
    log(`session/event listener FAILED: ${error?.message}`)
  }

  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      const header = agent?.session?.header
      if (header === undefined) return

      // Resolve the ROOT session without asking the runtime (see resolveRoot).
      const rootSessionId = resolveRoot(ctx, header)
      rootOfSession.set(header.id, rootSessionId)

      // A root session gets the delegation trigger; a delegated child never does,
      // so the guidance cannot recurse into grandchildren.
      if (header.origin !== 'subagent') {
        // The root agent has a live runtime here, so the official switch is readable.
        try {
          const team = ctx.get('agentTeams')
          if (team !== undefined && typeof team.isEnabled === 'function') {
            const on = team.isEnabled(agent) === true
            teamDecision.set(header.id, on)
            log(`team gate for session=${header.id}: ${on}`)
          }
        } catch (error) {
          log(`team gate read FAILED: ${error?.message}`)
        }
        // Publish a saved explicit choice once, so a client that mounts after
        // this session started still renders the right switch state.
        const savedState = readState()[header.id]
        if (savedState !== undefined) {
          recordGateOnce(agent.session, savedState.enabled === true)
            .catch(error => log(`gate: created record FAILED for session=${header.id}: ${error?.message}`))
        }
        const gate = gateFor(header, rootSessionId)
        if (!gate.on) {
          log(`trigger skipped for session=${header.id} (gate=${gate.source})`)
          return
        }
        try {
          agent.ctx.systemPrompt.section({
            name: 'matriline:trigger',
            order: 950,
            text: TRIGGER_TEXT,
          })
          log(`trigger registered for session=${header.id}`)
        } catch (error) {
          log(`trigger FAILED: ${error?.message}`)
        }

        // Converge the model-visible delegation surface to ONE entry point: the
        // official `subagent` / `subagent_fork` tools are hidden from this ROOT
        // session so the prompt guidance cannot be undercut by a second, dumber
        // delegator. Only the root is touched — a child's visible set is already
        // decided by the kind whitelist below, and denying there would fight it.
        // `restrictDelegationSurface` never throws, so a failed trim cannot
        // reject this serial `agent/created` listener (and with it the session).
        restrictDelegationSurface(agent, header.id, 'created')
        return
      }

      const id = header.id

      // Host-side proof that the fold works, independent of the client.
      if (edges !== undefined) {
        const session = agent.session
        setTimeout(() => {
          try {
            log(`  edges[${id}] = ${JSON.stringify(edges.stateOf(session))}`)
          } catch (error) {
            log(`  edges stateOf FAILED: ${error?.message}`)
          }
        }, 2000)
      }

      // ---- kind: recorded BEFORE any gate decision (security) ----------------
      // The granted kind is what `callerKindOf` must find for THIS child later,
      // when the child itself delegates. Registering it only inside the "gate on"
      // branch left no record whenever the gate was off (the switch off,
      // `matriline.paused`) or a reload cleared the map, and the privilege check
      // then had to guess. Recording it here is unconditional for every child:
      //   - an explicit kind from this plugin's own `delegate` tool is the truth;
      //   - otherwise the child inherits the parent's full surface, i.e. `write`.
      //
      // A kind this session was ALREADY granted ALWAYS wins, because a resumed
      // child re-fires this hook (`source: "resume"`) with no dispatch slot at all
      // — `send_message` woke it, nothing re-dispatched it. Falling back to
      // `write` there handed an ended READER a write sandbox and the writer tool
      // set. Three tiers, in order:
      //   1. `kindOfSession` — same process (fast path, logged "in-memory");
      //   2. the child's own `plugin:matriline/kind` record — survives a reload;
      //   3. the old dispatch default: the `pendingKind` slot, else `write`.
      const parentId = header.parentSession
      const explicitKind = pendingKind.has(parentId)
      const rememberedKind = kindOfSession.get(header.id)
      const kindFromMemory = Object.hasOwn(KIND_RANK, rememberedKind)
      const preservedKind = kindFromMemory
        ? rememberedKind
        : kindFromSessionLog(ctx, header.id, agent.session)
      const kind = preservedKind ?? (explicitKind ? pendingKind.get(parentId) : 'write')
      if (preservedKind !== undefined) {
        log(`child ${id}: kind preserved (${kindFromMemory ? 'in-memory' : 'durable'}): ${kind}`)
      }
      try {
        kindOfSession.set(header.id, kind)
      } catch (error) {
        log(`child ${id}: kind registration FAILED: ${error?.message}`)
      }

      // ---- lease: durable restore for a resumed writer ----------------------
      // The lease is the fourth dispatch-time fact, and the only one with a
      // SECURITY consequence: `send_message` re-fires this hook on a child that
      // ended long ago, whose lease was released on `subagent/end`. Without this
      // block the woken writer came back with no entry at all, and the Tier 2
      // guard passes every caller without an entry (that is the root/read path).
      // A NEW dispatch is skipped: `startChild` creates its lease and the hook
      // records it, so re-reserving here would race the promotion.
      if (kind === 'write' && !explicitKind) {
        const durableLease = leaseRecordFromSessionLog(ctx, id, agent.session)
        if (durableLease?.leased === false) {
          // This writer was never leased (a gate-defaulted kind, or a delegation
          // that had no workspace root). Nothing to restore, and no refusal: the
          // marker would deny a child that never had a claim to begin with.
          if (unleasedWriters.delete(id)) log(`child ${id}: unleased-writer marker cleared (record says leased=false)`)
        } else if (durableLease?.leased === true) {
          const restoredLease = restoreWriteLease(id, parentId, durableLease, leaseLabelOf(id), header.cwd)
          if (restoredLease !== undefined) {
            unleasedWriters.delete(id)
          } else if (preservedKind !== undefined) {
            unleasedWriters.set(id, { reason: 'the plugin:matriline/lease record could not be re-applied' })
          }
        } else if (preservedKind !== undefined) {
          if (pluginRecordUnavailable) {
            // No plugin-record writer exists in this process, so a missing record
            // proves NOTHING: the child simply could not have one. Denying every
            // resumed writer here would punish a deployment for the absence of an
            // optional dependency, so it continues unleased — and says so.
            log(`child ${id}: no lease record and no plugin-record writer; the resumed writer continues UNLEASED`)
          } else {
            // FAIL-CLOSED: a writer this plugin managed, resumed with no durable
            // claim. Refusing is the only answer that cannot become a bypass — the
            // alternative ("no record ⇒ no lease ⇒ no policing") is the bug.
            unleasedWriters.set(id, { reason: 'no plugin:matriline/lease record was found for this resumed writer' })
            log(`child ${id}: kind=write on resume but no lease record — write/edit/apply_patch will be REFUSED`)
          }
        }
      } else if (explicitKind) {
        // A new dispatch takes its lease from `startChild`; a marker left by an
        // earlier resume must not outlive it.
        if (unleasedWriters.delete(id)) log(`child ${id}: unleased-writer marker cleared (new dispatch)`)
      }

      // A kind granted earlier is enforced exactly like an explicit one: a resumed
      // reader must never lose its trimming just because the gate is now off.
      const kindEnforced = explicitKind || preservedKind !== undefined
      const gate = gateFor(header, rootSessionId)
      // ---- gate vs explicit kind (security) ---------------------------------
      // The gate decides ONE thing: whether a child that was NOT given a kind by
      // this plugin (the official `subagent` / `subagent_fork`, or any other
      // creator) is trimmed by default. A kind that was passed EXPLICITLY to
      // `delegate` is ALWAYS enforced — tool whitelist AND sandbox — because the
      // caller asked for a capability set and a switched-off gate must not turn
      // a requested reader into a writer.
      if (!gate.on && !kindEnforced) {
        log(`child ${id}: trimming off (gate=${gate.source}); no explicit kind was requested`)
        // Tier 3 does NOT depend on the trimming gate: an isolated writer still
        // gets its own worktree even when this session runs untrimmed.
        beginWorktree(ctx, agent, header)
        return
      }

      // ---- kind: persisted ONCE (resume fallback) ---------------------------
      // Only a FIRST decision writes it: a resume already found the record (or
      // the in-memory entry) and must not append a second one. Untrimmed children
      // get no record on purpose — nothing was granted to them, so a later resume
      // must keep falling back to the gate. The promise is caught here so an
      // unavailable writer can never reject this serial listener.
      if (preservedKind === undefined) {
        recordKindOnce(ctx, agent.session, kind, id).catch((error) => {
          log(`child ${id}: kind record FAILED (creation unaffected): ${error?.message}`)
        })
      }

      // ---- lease: recorded ONCE (resume fallback) --------------------------
      // The durable half of the lease, written for the common NON-isolated writer
      // (the child's own Session is guaranteed here). An isolated writer is
      // recorded from `startChild` AFTER the worktree settles, because its claim
      // is the checkout and not the declared scopes. A writer this plugin never
      // leased still gets a `{ leased: false }` record, so a later resume can tell
      // "never leased" apart from "the lease record is LOST" — the second one is
      // a refusal. Only a FIRST decision writes, exactly like kind/tools/skills:
      // a resumed child already read its record back and must not append a
      // second, contradicting one.
      if (kind === 'write' && preservedKind === undefined) {
        const reservationLease = pendingLeaseRecords.get(parentId)?.lease
        if (reservationLease === undefined) {
          recordLeaseOnce(ctx, agent.session, { leased: false }, id).catch((error) => {
            log(`child ${id}: lease record FAILED (creation unaffected): ${error?.message}`)
          })
        } else if (reservationLease.isolate !== true) {
          recordLeaseOnce(ctx, agent.session, leaseRecordOf(reservationLease), id).catch((error) => {
            log(`child ${id}: lease record FAILED (creation unaffected): ${error?.message}`)
          })
        }
      }

      // NOT `KIND_TOOLS[kind] ?? KIND_TOOLS.read`: `null` means "no fixed
      // whitelist for this kind", and nullish coalescing would silently treat it
      // as missing. A writer's real set comes from its `tools` profile below.
      const kindTools = Object.hasOwn(KIND_TOOLS, kind) ? KIND_TOOLS[kind] : KIND_TOOLS.read
      const kindSandbox = Object.hasOwn(KIND_SANDBOX, kind) ? KIND_SANDBOX[kind] : 'read-only'
      log(
        `child ${id}: depth=${String(header.delegationDepth)} gate=${gate.source} kind=${kind}`
        + `${kindEnforced
          ? ` kind enforced (${explicitKind ? 'explicit' : 'preserved'})`
          : ` (default, gate=${gate.source})`}`,
      )

      // ---- skills: three tiers, symmetric with kind/tools -------------------
      // `skills` decides ONE thing: whether the `skill` tool (and the ~3,000-
      // character catalog the skill plugin injects as a `user/message` on every
      // child that can see it) survives on this child. It used to be the only
      // dispatch field with no durable copy, which is exactly how a woken child
      // drifted: request #1 was 78 tools, request #2 was 79 for the same child.
      // Read order:
      //   1. `pendingSkills` — this START is a new dispatch (the slot is set for
      //      BOTH true and false, so "asked to strip" is a real answer);
      //   2. `skillsOfSession` — same process, previously decided (in-memory);
      //   3. the child's own `plugin:matriline/skills` record — survives reload;
      //   4. the documented default: `false`.
      const skillsFromDispatch = pendingSkills.has(parentId)
      const askedSkills = skillsFromDispatch ? pendingSkills.get(parentId) === true : undefined
      const cachedSkillsValue = skillsOfSession.get(header.id)
      const cachedSkills = typeof cachedSkillsValue === 'boolean' ? cachedSkillsValue : undefined
      const preservedSkills = skillsFromDispatch
        ? undefined
        : cachedSkills ?? skillsFromSessionLog(ctx, header.id, agent.session)
      const skills = skillsFromDispatch ? askedSkills === true : preservedSkills ?? false
      if (preservedSkills !== undefined) {
        log(
          `child ${id}: skills preserved (${cachedSkills !== undefined ? 'in-memory' : 'durable'}): `
          + String(skills),
        )
      }
      try {
        skillsOfSession.set(header.id, skills)
      } catch (error) {
        log(`child ${id}: skills registration FAILED: ${error?.message}`)
      }
      // A resume already read the value back and must not append a second record;
      // only a FIRST decision (new dispatch or default) writes one — for BOTH
      // values, so a child that decided "strip" cannot later be read as "unknown"
      // and drift. Caught here so an unavailable writer never rejects this
      // serial listener.
      if (preservedSkills === undefined) {
        recordSkillsOnce(ctx, agent.session, skills, id).catch((error) => {
          log(`child ${id}: skills record FAILED (creation unaffected): ${error?.message}`)
        })
      }

      // ---- write tools profile ---------------------------------------------
      // A writer used to inherit the parent's whole surface (measured: 77 tools,
      // ~76K characters of schema) to call ~6 of them. The DEFAULT is now the
      // minimal writer set; `tools:"full"` restores the inherited surface and a
      // name array keeps exactly those names. Readers/verifiers keep the fixed
      // `kindTools` whitelist, still intersected with what this deployment
      // actually exposes (`read_image` is optional): an empty intersection must
      // fall back to the safe read subset or to a DENY list, never to "inherit".
      let appliedTools = kindTools === null ? null : chooseAllowTools(agent, kindTools, SAFE_READ_TOOLS)
      // True whenever a TRIMMED surface was requested by the kind or the tools
      // profile. A writer with `tools:"full"` asked for the inherited set and
      // must never hit the fail-safe deny below.
      let trimRequested = kindTools !== null
      let toolsFullPreserved = false
      if (kind === 'write') {
        // Three tiers, symmetric with `kind`:
        //   1. `pendingTools` — this START is a new dispatch (the slot is set only
        //      around `startActivation`), so the caller's request wins;
        //   2. `toolsOfSession` — same process, a previously decided profile
        //      (fast path, logged "in-memory");
        //   3. the child's own `plugin:matriline/tools` record — survives a
        //      plugin reload; without it a woken writer quietly lost `full`.
        // Only when none of them answers does the documented default apply.
        const fromDispatch = pendingTools.has(parentId)
        const pendingProfile = fromDispatch
          ? resolveToolsProfile(pendingTools.get(parentId), ` (child ${id})`)
          : undefined
        const cachedProfile = asResolvedToolsProfile(toolsOfSession.get(header.id))
        const preservedProfile = pendingProfile === undefined
          ? cachedProfile ?? toolsProfileFromSessionLog(ctx, header.id, agent.session)
          : undefined
        const profile = pendingProfile ?? preservedProfile ?? resolveToolsProfile(undefined, ` (child ${id})`)
        if (preservedProfile !== undefined) {
          log(
            `child ${id}: tools profile preserved (${cachedProfile !== undefined ? 'in-memory' : 'durable'}): `
            + describeToolsProfile(profile),
          )
        }
        try {
          toolsOfSession.set(header.id, profile)
        } catch (error) {
          log(`child ${id}: tools profile registration FAILED: ${error?.message}`)
        }
        // A resume already read the profile back and must not append a second
        // record; only a FIRST decision (dispatch or default) writes one. Caught
        // here so an unavailable writer can never reject this serial listener.
        if (preservedProfile === undefined) {
          recordToolsOnce(ctx, agent.session, profile, id).catch((error) => {
            log(`child ${id}: tools record FAILED (creation unaffected): ${error?.message}`)
          })
        }
        toolsFullPreserved = preservedProfile !== undefined && profile.mode === 'full'
        if (profile.mode === 'full') {
          appliedTools = null
          log(toolsFullPreserved ? '  tools: full (preserved)' : '  tools: full (inherited)')
        } else {
          trimRequested = true
          const requested = profile.mode === 'list' ? [...profile.names] : [...WRITE_MINIMAL_TOOLS]
          // The DURABLE decision above, never the dispatch slot: a resumed child
          // keeps `skill` (or keeps it stripped) exactly as first decided, and
          // `skills: true` keeps its meaning under the minimal profile too — the
          // tool is added to the request instead of being left out of a list the
          // caller could not know about.
          if (skills === true) {
            requested.push('skill')
          } else {
            // An explicit names array may name `skill`; without `skills: true` it
            // is stripped like everywhere else, so it never reaches `allow`.
            if (requested.includes('skill')) {
              for (let at = requested.length - 1; at >= 0; at -= 1) {
                if (requested[at] === 'skill') requested.splice(at, 1)
              }
              log('  skill stripped (skills=false): left out of the requested names')
            }
          }
          // Intersect BEFORE restrict: `apply_patch` / `bash` do not exist in every
          // deployment, and `restrict({allow})` throws on an unknown name — which
          // would reject the whole child creation from this serial listener. An
          // empty intersection falls back to the documented minimal writer set and
          // then to the safe read subset; it must NEVER mean "inherit everything".
          appliedTools = chooseAllowTools(
            agent,
            requested,
            profile.mode === 'list' ? WRITE_MINIMAL_TOOLS : SAFE_READ_TOOLS,
          )
          log(
            appliedTools === null
              ? `  tools: ${profile.mode} profile resolved to 0 visible tools — fail-safe deny instead of inheriting`
              : `  tools: ${profile.mode} profile → ${appliedTools.length} tools`,
          )
        }
      }

      let allowApplied = false
      if (appliedTools !== null) {
        try {
          // A name missing from the restrictable set makes restrict() throw, and a
          // throwing agent/created listener rejects the whole child creation. The
          // restrictable set has no public accessor, so the guard is this catch.
          agent.ctx.tools.restrict({ allow: appliedTools })
          allowApplied = true
          log(`  restricted -> [${appliedTools.join(', ')}]`)
        } catch (error) {
          log(`  restrict FAILED: ${error?.message}`)
        }
      } else {
        log('  tools left inherited')
      }
      // A trim was requested but NO allow list could be applied. Denying the
      // dangerous names is strictly safer than the old silent inheritance; when
      // even that deny throws, the log says the surface is UNTRIMMED, because
      // there is no further public seam to close.
      if (trimRequested && !allowApplied) {
        denyFallbackSurface(agent, id, appliedTools === null ? 'created-empty-allow' : 'created-restrict-failed')
      }

      // ---- skill: ONE rule, no exemption, decoupled from the allow result ---
      // `skill` is kept ONLY when `skills === true` (the durable decision read
      // above). EVERY other case strips it: a fresh `minimal`/`names` profile
      // (its allow list already excludes the name), a RESUME, and `tools:"full"`
      // — where nothing was allow-restricted, so this deny is the only thing
      // between the child and the +3K catalog. The old code exempted
      // `toolsFullPreserved` here, which is why a `full` writer came back from a
      // `send_message` wake-up with one more tool than it was created with.
      // It ALSO skipped this deny whenever `appliedTools` was non-null, even if
      // `restrict({allow})` had just thrown — so a failed trim kept both the full
      // surface and the catalog. The deny is therefore independent of the allow
      // result, and skipped only when the allow list provably excludes `skill`.
      const skillExcludedByAllow = allowApplied && appliedTools !== null && !appliedTools.includes('skill')
      if (skills === true) {
        log('  skill kept (skills=true)')
      } else if (skillExcludedByAllow) {
        log('  skill stripped (already outside the allow list)')
      } else {
        try {
          const skillDeny = filterDeniableTools(agent, ['skill'])
          if (skillDeny.length > 0) {
            agent.ctx.tools.restrict({ deny: skillDeny })
            log('  skill stripped (skills=false)')
          }
        } catch (error) {
          log(`  skill suppression FAILED: ${error?.message}`)
        }
      }

      try {
        agent.session.append('sandbox/mode', { mode: kindSandbox, source: 'delegation' })
        log(`  sandbox -> ${kindSandbox}`)
      } catch (error) {
        log(`  sandbox append FAILED: ${error?.message}`)
      }

      // Recursion budget: only tell the child it may delegate while another level
      // still fits under the host's configured maxDepth (profile sets 3).
      let maxDepth
      try {
        maxDepth = ctx.get('subagents')?.resolveMaxDepth?.()
      } catch (error) {
        maxDepth = undefined
      }
      const depth = header.delegationDepth ?? 0
      const depthAllows = maxDepth === undefined || depth < maxDepth
      if (!depthAllows) log(`  no delegate guidance: depth ${depth} >= maxDepth ${String(maxDepth)}`)

      // A child that CAN delegate must be told so: its prompt is either the stock
      // deployment prompt or the compact reader one, and neither mentions fan-out.
      // For the compact path the guidance goes INSIDE that complete section —
      // a complete section replaces every other section at assembly time.
      const canDelegate = (appliedTools === null || appliedTools.includes('delegate')) && depthAllows
      // The PROMPT replacement stays a gate decision (it rewrites the child's
      // whole system prompt): with the gate off, an explicitly-read child still
      // gets its read-only tool whitelist and sandbox, but keeps the stock prompt.
      const compactPrompt = gate.on && !existsSync(PROMPT_OFF_FLAG) && kindTools !== null
      if (canDelegate && !compactPrompt) {
        try {
          agent.ctx.systemPrompt.section({
            name: 'matriline:child-trigger',
            order: 950,
            text: CHILD_TRIGGER_TEXT,
          })
          log('  child trigger registered (section)')
        } catch (error) {
          log(`  child trigger FAILED: ${error?.message}`)
        }
      }

      if (compactPrompt) {
        try {
          const cwd = header.cwd ?? '(unknown)'
          const lines = [
            'You are a delegated read-only subagent inside DeepSeek Harness.',
            `Working directory: ${cwd}`,
            'Tools: read, grep, glob, read_image, list_agents, send_message, delegate, cancel_subagent.',
            'You cannot write files, run commands, or ask for approval.',
            '',
            'Rules:',
            '- Answer the task directly. No preamble, no restating the task.',
            '- Cite `path:line` for every factual claim, from files you actually read.',
            '- If something is absent, say "not found" instead of guessing.',
            '- If the task cannot be finished from the files you can see, state exactly what is missing.',
          ]
          if (canDelegate) {
            lines.push(
              '',
              'Delegation: you may split a sub-task to your own children with `delegate(task, kind)`',
              '(kind="read" is cheap and read-only). Do it only when the sub-task needs reading many',
              'files or an independent check; keep the final judgement yourself.',
              'If `delegate` fails because subagent slots are full, do not retry: finish it yourself.',
            )
          }
          const text = lines.join('\n')
          agent.ctx.systemPrompt.section({
            name: 'matriline:compact-prompt',
            order: 100,
            text,
            complete: true,
          })
          log(`  compact prompt registered (${text.length} chars, delegate=${String(canDelegate)})`)
        } catch (error) {
          log(`  prompt trim FAILED: ${error?.message}`)
        }
      }

      // Tier 3: kicked off AFTER the trimming decision (tools/sandbox/prompt are
      // already fixed), so an isolated writer's surface is the normal write one.
      // The attempt is only started here; the parent's dispatch awaits it and the
      // result carries `worktree` or `worktreeError`. Never throws on its own.
      beginWorktree(ctx, agent, header)

    } catch (error) {
      log(`handler threw: ${error?.message}`)
    }
  })
}
