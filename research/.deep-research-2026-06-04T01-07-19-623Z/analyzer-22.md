## 1. Behavioral model

This partition is the **packaging bridge** between source checkout, published npm tarball, and standalone Bun binaries.

- `packages/coding-agent/scripts/copy-builtin-packages.ts` copies the private workspace companions into `packages/coding-agent/dist/builtin/`.
- `packages/coding-agent/scripts/copy-runtime-dependencies.ts` copies the runtime dependency closure into a `node_modules` tree for binary archives.
- `packages/coding-agent/src/core/builtin-packages.ts` resolves where those bundled packages live at runtime:
  - source checkout: `packages/<builtin>`
  - npm/dist: `packages/coding-agent/dist/builtin/<package>`
  - binary layout: adjacent `builtin/<package>` next to the executable

So the repo’s “published product” is not just compiled TS; it is a **hybrid payload**: compiled CLI + copied TS-builtins + copied runtime deps + assets.

## 2. Key flows and invariants

### Builtin package bundling
`copy-builtin-packages.ts`:
1. Deletes `dist/builtin/`.
2. Copies only workspace companions:
   - workflows
   - subagents
   - mcp
   - web-access
   - intercom
3. Skips tests, maps, VCS, and build junk.
4. Special-cases workflows:
   - emits `authoring.d.ts`
   - prunes raw `.ts` authoring sources so consumers don’t resolve into leaky source
   - generates an ambient bridge for `@bastani/workflows` → `@bastani/atomic/workflows`
   - injects a reference into `dist/index.d.ts`

**Invariant:** builtin package names must match their `package.json` names exactly, or the copier fails.

### Runtime dependency copying
`copy-runtime-dependencies.ts`:
1. Reads the package manifest.
2. Starts from direct dependencies + optional dependencies.
3. Recursively copies each dependency’s own dependency closure.
4. Skips optional deps if absent.
5. Fails hard if a required dependency directory or `package.json` is missing.

**Invariant:** the binary archive must contain a self-contained `node_modules` tree for all required runtime deps.

### Runtime resolution
`getBuiltinPackagePaths()`:
- probes source/dist/binary locations in order
- validates each candidate by:
  - required entrypoint exists
  - package name matches expected package name

**Coupling:** the resource loader depends on this to register builtin extensions, workflows, skills, and slash commands.

## 3. Tests / validation

Covered directly:
- `test/unit/runtime-dependency-copy.test.ts`
  - verifies recursive dependency copying
  - verifies missing required deps throw
- `test/unit/coding-agent-builtin-workflows.test.ts`
  - verifies source-checkout discovery
  - verifies binary-adjacent discovery
  - verifies builtin packages load into the resource loader

CI/docs also validate the package shape:
- `bun run build`
- `scripts/build-binaries.sh`
- `dist/builtin` must contain all bundled extensions
- `bun pm pack --dry-run`

## 4. Risks, unknowns, and verification steps

### Risks for a TypeScript → Rust migration
- This logic assumes **TS/JS modules remain loadable** via jiti and the current extension API.
- Builtins are not just “files”; they are part of a **dynamic plugin ecosystem**.
- `copy-runtime-dependencies.ts` only works for npm-style dependency trees; a Rust rewrite would need a new packaging model or a JS compatibility layer.

### Unknowns
- Whether every runtime dependency is actually needed in the compiled binary on every platform.
- Whether any builtin package relies on non-obvious files that are currently preserved by the copy filter.
- Whether the ambient workflow declaration generation fully covers all exported workflow subpaths.

### Verify before migration
- Inspect `dist/builtin` contents from a real build.
- Run binary smoke tests for `atomic --version` and a no-session runtime flow.
- Confirm extension/resource loading still resolves from the binary archive layout.
- Inventory which dependencies are truly runtime-critical versus incidental build-time deps.

If you want, I can turn this into a **Rust migration seam map** for just this partition.