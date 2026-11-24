# Contributing

Thanks for contributing to `@wdlpiaoyi/dsh-matriline`. This plugin runs inside the DeepSeek Harness, so changes to leases, path handling, or `kind` semantics affect security boundaries — keep diffs small and explain the impact.

## Development setup

1. Clone the public repository; no credentials are needed:

   ```bash
   git clone https://github.com/wdlpiaoyi/dsh-matriline.git
   ```

2. There are no dependencies and no build step. `package.json` declares no `dependencies` and no `scripts`, and `files` ships the sources as-is, so `npm install` is not required.

3. Syntax-check every entry point:

   ```bash
   node --check index.js
   node --check client.js
   node --check state/index.js
   ```

4. Run the test suite:

   ```bash
   node --test
   ```

5. Smoke-import with `DSH_HOME` and `MATRILINE_HOME` in a temporary directory, so nothing touches `~/.dsh`. Windows PowerShell:

   ```powershell
   $env:DSH_HOME = Join-Path $env:TEMP 'matriline-smoke'
   $env:MATRILINE_HOME = Join-Path $env:TEMP 'matriline-smoke-data'
   node -e "import('./index.js').then(m => console.log(m.name))"
   node -e "import('./state/index.js').then(m => console.log(typeof m.apply))"
   ```

   POSIX shell:

   ```bash
   DSH_HOME="$(mktemp -d)" MATRILINE_HOME="$(mktemp -d)" node -e "import('./index.js').then(m => console.log(m.name))"
   DSH_HOME="$(mktemp -d)" MATRILINE_HOME="$(mktemp -d)" node -e "import('./state/index.js').then(m => console.log(typeof m.apply))"
   ```

## Pull requests

- State the capability (`kind`), write-scope, and path-handling impact in the PR description.
- The only test suite is `test/`; there is no other suite yet. PRs that change leases, path handling, or `kind` semantics must add or update cases there.
- Run the syntax checks and tests above before opening the PR.

## Release checklist

- [ ] Bump `version` in `package.json` and add the entry to `CHANGELOG.md`.
- [ ] Verify the `files` list covers what should ship: `index.js`, `client.js`, `state/`, `cordis.patch.yml`, `README.md`, `README.en.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`.
- [ ] Verify the README claims against the tree (`engines.node`, `engines.dsh`, the `LICENSE` copyright line, and the install targets).
- [ ] Review the tarball contents with `npm pack --dry-run`.
- [ ] Commit and push; a clean CI run on `main` is the gate.

### Publishing (tag-triggered)

`.github/workflows/publish.yml` runs on a `v*` tag: it re-runs the checks, verifies the tag equals the `package.json` version, and publishes with npm provenance.

```bash
git tag v0.12.0
git push origin v0.12.0
```

The workflow needs one credential, configured once:

- **First publish (the package does not exist yet):** create an npm automation token and store it as the `NPM_TOKEN` secret on GitHub (`gh secret set NPM_TOKEN`). The token publishes and claims the name in the same step — trusted publishing cannot bootstrap a package that does not exist yet.
- **After the package exists:** prefer trusted publishing. On npmjs.com → package settings → Trusted Publisher, point it at this repository and `publish.yml`, delete the `NODE_AUTH_TOKEN` line from the workflow, and pin `npm >= 12` in that job. No long-lived token remains.

Manual fallback: `npm login && npm publish --access public` (needs your 2FA code; use `--otp=123456` when scripting).
