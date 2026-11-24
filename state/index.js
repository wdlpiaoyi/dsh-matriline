/**
 * `@wdlpiaoyi/dsh-matriline/state` — the profile-owned config row the model-menu
 * switch writes. It carries only the per-session trim map and publishes it on a
 * process-wide store; the main plugin never has to be the settings-editor target.
 *
 * It is a subpath of the `@wdlpiaoyi/dsh-matriline` package (not a bundle of its
 * own) so the plugin page lists ONE matriline bundle whose rows are the plugin
 * and this state row. The matriline bundle patch inserts both rows.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The plugin's data directory, resolved exactly like the host half: `$MATRILINE_HOME`
 * wins, otherwise `<DSH home>/matriline`. One rule for both halves means the state
 * row's log and the main plugin's log can never drift into different directories.
 */
function dataHome() {
  try {
    const fromEnv = process.env.MATRILINE_HOME
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    // Legacy codename from before the public release; kept so existing shells keep working.
    const legacyHome = process.env.FISHSCHOOL_HOME
    if (typeof legacyHome === 'string' && legacyHome.trim() !== '') return legacyHome.trim()
  } catch {
    /* no environment: fall through to the DSH home */
  }
  try {
    const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
    return join(dshHome, 'matriline')
  } catch {
    return join(process.cwd(), '.matriline')
  }
}

function note(line) {
  try {
    const log = join(dataHome(), 'matriline.log')
    mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
    appendFileSync(log, `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* logging must never break the row */
  }
}
note('matriline/state: module loaded')

function normalizeSessions(value) {
  const sessions = {}
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.sessions : undefined
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [id, enabled] of Object.entries(source)) {
      if (typeof id === 'string' && id !== '' && typeof enabled === 'boolean') sessions[id] = enabled
    }
  }
  return sessions
}

export const Config = {
  type: 'object',
  meta: { volatile: true },
  dict: {
    sessions: { type: 'dict', inner: { type: 'boolean', meta: {} }, meta: { default: {} } },
  },
  '~standard': {
    version: 1,
    vendor: 'matriline/state',
    validate(value) {
      return { value: { sessions: normalizeSessions(value) } }
    },
  },
  toJSON() {
    return {
      type: 'object',
      meta: {},
      dict: {
        sessions: { type: 'dict', inner: { type: 'boolean', meta: {} }, meta: { default: {} } },
      },
    }
  },
}

const STORE_KEY = Symbol.for('dsh-matriline.state')

/** Process-wide store shared with the main plugin (they are sibling fibers). */
function stateStore() {
  let store = globalThis[STORE_KEY]
  if (store === undefined) {
    store = { sessions: {}, listeners: new Set() }
    globalThis[STORE_KEY] = store
  }
  return store
}

export function apply(ctx, config) {
  note(`matriline/state: apply sessions=${Object.keys(normalizeSessions(config)).length}`)
  const store = stateStore()
  const publish = (nextConfig) => {
    const before = store.sessions
    store.sessions = normalizeSessions(nextConfig)
    for (const callback of [...store.listeners]) {
      try { callback(store.sessions, before) } catch (error) {
        try { ctx.logger?.warn?.('matriline/state: watcher failed', error) } catch {}
      }
    }
  }
  publish(config)
  ctx.on('internal/update', function (nextConfig, _noSave, next) {
    try {
      const fiber = this?.fiber ?? this
      if (fiber === ctx.fiber) publish(nextConfig)
    } catch (error) {
      try { ctx.logger?.warn?.('matriline/state: update failed', error) } catch {}
    }
    return next()
  })
}
