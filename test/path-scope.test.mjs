// Path and write-scope unit tests.
//
// These cover the pure helpers behind the write guard: a regression here is a
// SILENT security downgrade (a scope that no longer covers what it claims, or a
// refusal that stops refusing), so they run in CI on every push.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The data dir must be redirected BEFORE the module is imported: index.js creates
// its data directory at module load so a checkout never writes into ~/.dsh.
const sandbox = mkdtempSync(join(tmpdir(), 'matriline-test-'))
process.env.DSH_HOME = sandbox
process.env.MATRILINE_HOME = join(sandbox, 'matriline')

const { __test } = await import('../index.js')
const {
  KIND_RANK,
  normalizeScopePath,
  scopeCovers,
  scopesOverlap,
  resolveWriteScopes,
  pathArgumentsOf,
  pluginProtectedScopes,
} = __test

test('kind ranks are monotonic: a read/verify caller cannot reach write', () => {
  assert.equal(KIND_RANK.read, 0)
  assert.equal(KIND_RANK.verify, 0)
  assert.equal(KIND_RANK.write, 1)
  assert.ok(KIND_RANK.write > KIND_RANK.read)
  assert.ok(KIND_RANK.write > KIND_RANK.verify)
})

test('scopeCovers: a subtree scope covers itself and its children, not siblings', () => {
  const subtree = { value: '/tmp/tree', dir: true }
  assert.equal(scopeCovers('/tmp/tree', subtree), true)
  assert.equal(scopeCovers('/tmp/tree/child.txt', subtree), true)
  assert.equal(scopeCovers('/tmp/tree/deep/nested/file.js', subtree), true)
  assert.equal(scopeCovers('/tmp/treemate/child.txt', subtree), false)
  assert.equal(scopeCovers('/tmp', subtree), false)
})

test('scopeCovers: a file scope covers exactly one path', () => {
  const file = { value: '/tmp/tree/file.js', dir: false }
  assert.equal(scopeCovers('/tmp/tree/file.js', file), true)
  assert.equal(scopeCovers('/tmp/tree/file.js.bak', file), false)
  assert.equal(scopeCovers('/tmp/tree/other.js', file), false)
})

test('scopesOverlap is symmetric and treats nesting as overlap', () => {
  const parent = { value: '/tmp/work', dir: true }
  const child = { value: '/tmp/work/src', dir: true }
  const sibling = { value: '/tmp/other', dir: true }
  assert.equal(scopesOverlap(parent, child), true)
  assert.equal(scopesOverlap(child, parent), true)
  assert.equal(scopesOverlap(parent, sibling), false)
  assert.equal(scopesOverlap(sibling, parent), false)
})

test('normalizeScopePath: keeps a directory flag for the three subtree forms', () => {
  const base = normalizeScopePath('/tmp/work')
  assert.ok(base !== undefined)
  assert.equal(normalizeScopePath('/tmp/work/**', undefined).dir, true)
  assert.equal(normalizeScopePath('/tmp/work/*', undefined).dir, true)
  assert.equal(normalizeScopePath('/tmp/work/', undefined).dir, true)
  assert.equal(normalizeScopePath('/tmp/work/file.js', undefined).dir, false)
})

test('normalizeScopePath: relative paths resolve against the base and ".." is collapsed', () => {
  const base = normalizeScopePath('/tmp/work')
  const inside = normalizeScopePath('src/a.js', base.value)
  assert.ok(inside !== undefined)
  assert.equal(inside.dir, false)
  const lexical = inside.value.endsWith('/src/a.js')
  assert.equal(lexical, true)
  const up = normalizeScopePath('../sibling/file.js', base.value)
  assert.ok(up !== undefined)
  assert.equal(up.value.endsWith('/sibling/file.js'), true)
})

test('normalizeScopePath: rejects unusable input instead of inventing a scope', () => {
  assert.equal(normalizeScopePath('', undefined), undefined)
  assert.equal(normalizeScopePath(42, undefined), undefined)
  assert.equal(normalizeScopePath('   ', undefined), undefined)
})

test('resolveWriteScopes: refuses scopes that climb out of the workspace root', () => {
  const base = normalizeScopePath('/tmp/work')
  const result = resolveWriteScopes(['../escape/file.js'], base)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'WRITE_SCOPE_INVALID')
})

test('resolveWriteScopes: refuses unsupported wildcards rather than leasing nothing', () => {
  const base = normalizeScopePath('/tmp/work')
  const result = resolveWriteScopes(['src/*.js'], base)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'WRITE_SCOPE_INVALID')
})

test('resolveWriteScopes: accepts in-workspace paths and keeps the declared shape', () => {
  const base = normalizeScopePath('/tmp/work')
  const result = resolveWriteScopes(['src/**', 'docs/readme.md'], base)
  assert.equal(result.ok, true)
  const dirs = result.scopes.filter(scope => scope.dir === true)
  const files = result.scopes.filter(scope => scope.dir === false)
  assert.equal(dirs.length, 1)
  assert.equal(files.length, 1)
  assert.equal(files[0].value.endsWith('/docs/readme.md'), true)
})

test('pathArgumentsOf: every named path is collected, including patch headers', () => {
  assert.deepEqual(pathArgumentsOf({ file_path: 'a.js' }), ['a.js'])
  const patch = '*** Begin Patch\n*** Update File: b.js\n*** Add File: c.js\n*** End Patch'
  const both = pathArgumentsOf({ file_path: 'a.js', patch })
  assert.deepEqual(both, ['a.js', 'b.js', 'c.js'])
  const moved = '*** Update File: old.js\n*** Move to: new.js\n'
  assert.deepEqual(pathArgumentsOf({ patch: moved }), ['old.js', 'new.js'])
  assert.deepEqual(pathArgumentsOf({}), [])
  assert.deepEqual(pathArgumentsOf('not json'), [])
})

test('pluginProtectedScopes covers the data dir and the package dir', () => {
  const scopes = pluginProtectedScopes()
  assert.equal(scopes.length, 2)

  const stateFile = normalizeScopePath(join(process.env.MATRILINE_HOME, 'matriline.paused'))
  assert.ok(stateFile !== undefined)
  assert.equal(scopes.some(scope => scopeCovers(stateFile.value, scope)), true)

  const moduleFile = normalizeScopePath(join(process.cwd(), 'index.js'))
  assert.ok(moduleFile !== undefined)
  assert.equal(scopes.some(scope => scopeCovers(moduleFile.value, scope)), true)
})
