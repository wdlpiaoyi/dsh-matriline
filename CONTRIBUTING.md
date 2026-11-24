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

- [ ] Bump `version` in `package.json`.
- [ ] Verify the `files` list covers what should ship. It currently ships `index.js`, `client.js`, `state/`, `cordis.patch.yml`, `README.md`, `README.en.md`, and `LICENSE`; add `SECURITY.md`, `CONTRIBUTING.md`, and `CHANGELOG.md` there if you want the README links to resolve on the npm page.
- [ ] Verify the README claims against the tree: `engines.node` / `engines.dsh` match the "Environment requirements" and "Compatibility" sections, and the copyright line in `LICENSE` matches the "License" section.
- [ ] Review the tarball contents:

  ```bash
  npm pack --dry-run
  ```

- [ ] Update `CHANGELOG.md` before tagging.
- [ ] Commit, tag the release (for example `git tag v0.12.0`), and publish under the `@wdlpiaoyi` scope:

  ```bash
  npm publish --access public
  ```
