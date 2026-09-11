# AGENTS.md

Development notes for coding agents working on this repository.

## Project overview

*pi-requesty-discover* is a Pi Coding Agent package/extension for discovering available Requesty models, optionally
health-checking them, and updating Pi's local *models.json*.

Pi loads the extension directly from TypeScript through the package manifest:

```json
{
  "main": "src/index.ts",
  "pi": {
    "extensions": [
      "./index.ts"
    ]
  }
}
```

`index.ts` is a small public entrypoint that re-exports the implementation from `src/index.ts`, so installed-package
provenance displays a useful path. Keep the implementation in `src/` unless there is a good reason to change the package
entrypoint.

Do **not** add a build/transpile step unless explicitly requested.

## Source layout

- index.ts – package-facing Pi extension entrypoint; re-exports src/index.ts
- src/
  - index.ts — Pi command registration, event wiring, and ctx-dependent UI adapters for the discovery workflow
  - discovery.ts — pure discovery workflow logic (evaluate, finalize, argument completions)
  - env.ts — environment variables and paths to Pi
  - models-json.ts — read/validate/update models.json
  - requesty-api.ts — Requesty models library API
  - health-check.ts — model health checks and health-check log writing
  - settings.ts — read various settings
  - utils.ts — utility functions
  - *.test.ts — unit tests colocated with source files
  - ui/ – contains ui components
- test/
  - integration.test.ts — integration tests
  - helpers/ — integration test helpers

## Conventions

- Follow test-driven development for behavior-changing code: **red, green, refactor**. Add or update the test that
  exposes the issue or missing behavior, verify it fails for the right reason, then implement the change and clean up.
- Use TypeScript for source files.
- Keep imports extensionless inside `src`, e.g. `import env from './env'`.
- Use Pi's exported types where available, especially:
  - `ExtensionAPI`
  - `ExtensionCommandContext`
  - `ProviderConfig`
  - `ProviderModelConfig`
- Use `zod` for runtime validation of external data:
  - environment values
  - things from the *models.json*
  - Requesty API responses
- Keep all environment/path access centralized in `src/env.ts`.
- Keep the Pi command name centralized in `src/index.ts` as `COMMAND_NAME`.
- `REQUESTY_HEALTH_CHECK_MODE` is validated as `off | basic | full`.
- `docs/DECISIONS.adoc` is for design decisions with non-obvious trade-offs (why X over Y), not implementation
  details. Do not add a record there for ordinary refactors, naming, or structure changes — if in doubt, leave it out.
- Keep ports/adapters minimal: one seam per actual variation axis. Prefer a single `DiscoveryUi` port with a tui and a
  console adapter over one interface per concern; prefer bare function types (`GetApiKey`) over single-method objects.
- The main doc entrypoint for this project is `README.adoc`. Any possibly existing *README.md* is just auto-generated
  and should not be edited.

## Development commands

Run these before handing off changes:

```bash
# linting and format checking all-in-one
npm run check
# run all tests
npm test
```

Use formatting when needed:

```bash
npm run format
```

## Publishing

Releasing a new version is a human-only task. Do not run the release script under
any circumstances, including with extra flags — ask the user to run it
themselves. `npm run release` prompts for a `y/N` confirmation before bumping
the version, tagging, and pushing; do not answer that prompt on the user's
behalf. Publishing to npm itself is a separate manual step and is not
automated by CI.

## Package notes

Published files are controlled by `.npmignore` (npm uses its default ignores plus any rules listed there). Test files
are excluded automatically.

Runtime dependencies belong in `dependencies`; development-only tools belong in `devDependencies`. Pi-provided packages
such as `@earendil-works/pi-coding-agent` should stay in `peerDependencies` with a `"*"` range.

## References

- See `docs/DECISIONS.adoc` for design decisions.
