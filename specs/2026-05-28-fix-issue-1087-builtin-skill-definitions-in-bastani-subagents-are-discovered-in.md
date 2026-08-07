# Atomic Technical Design Document / RFC

| Document Metadata      | Details                                             |
| ---------------------- | --------------------------------------------------- |
| Author(s)              | Norin Lavaee                                        |
| Status                 | Draft (WIP)                                         |
| Team / Owner           | Atomic Subagents maintainers / `@bastani/subagents` |
| Created / Last Updated | 2026-05-27 / 2026-05-27                             |

## 1. Executive Summary

Fix issue #1087 by aligning `@bastani/subagents` skill resolution with Atomic’s builtin package resource discovery. Today the main Atomic chat loads builtin package skills from `@bastani/subagents` through `DefaultResourceLoader`, but subagent execution resolves requested agent skills independently in `packages/subagents/src/agents/skills.ts`. As a result, builtin agents such as `debugger` declare `skills: tdd, browser` in `packages/subagents/agents/debugger.md:8`, yet child execution can warn `Skills not found: tdd, browser` when run from the repo root or a normal project cwd.

The proposed minimal fix is to add builtin package skill roots to the subagent resolver’s search path by reusing Atomic’s exported `getBuiltinPackagePaths()` and existing `pi.skills` manifest extraction. This preserves current project/user/settings/package discovery and source precedence while making builtin skill injection available to foreground, async single, and async chain subagent runs without changing those execution paths.

Tests will be written first. The core red test should demonstrate that, from the repository root, `resolveSkills(["tdd", "browser"], process.cwd())` resolves to `packages/subagents/skills/*/SKILL.md` instead of returning both names in `missing`.

## 2. Context and Motivation

### 2.1 Current State

Atomic bundles first-party companion packages into `@bastani/atomic`; `docs/ci.md:5-7` and `docs/ci.md:52-60` document that `@bastani/subagents` is copied into `packages/coding-agent/dist/builtin/` and is not published independently.

Main chat resource discovery already supports builtin packages:

- `packages/coding-agent/src/core/builtin-packages.ts:26-57` declares workspace builtins, including `@bastani/subagents`.
- `packages/coding-agent/src/core/builtin-packages.ts:140` exports `getBuiltinPackagePaths()`.
- `packages/coding-agent/src/main.ts:533` computes `builtinPackagePaths`.
- `packages/coding-agent/src/main.ts:546-551` passes those paths into `DefaultResourceLoader`.
- `packages/coding-agent/src/core/resource-loader.ts:335-372` resolves builtin package resources.
- `packages/coding-agent/src/core/resource-loader.ts:449-456` merges builtin skill resources into the skill paths loaded by main chat.

Evidence from investigation: a Bun script using `DefaultResourceLoader` with `builtinPackagePaths: [resolve("packages/subagents")]` resolved `browser`, `tdd`, and `subagent` to `packages/subagents/skills/*/SKILL.md`.

Subagent execution has a separate resolver:

- `packages/subagents/src/agents/skills.ts:317` builds subagent skill search paths.
- It currently searches project `.atomic/.pi` skill dirs, project `.agents/skills`, user skill dirs, installed package roots, settings packages, the current `cwd` package manifest, and settings skill paths.
- `packages/subagents/src/agents/skills.ts:106` reads `pi.skills` from a package root.
- `packages/subagents/src/agents/skills.ts:529` resolves requested names.
- `packages/subagents/src/agents/skills.ts:561` provides primary/fallback cwd resolution.
- `packages/subagents/src/agents/skills.ts:577` builds the injected `<skill name="...">` system prompt block.

The foreground and background execution paths already use this resolver:

- Foreground: `packages/subagents/src/runs/foreground/execution.ts:768-785`.
- Async chain: `packages/subagents/src/runs/background/async-execution.ts:307-316`.
- Async single: `packages/subagents/src/runs/background/async-execution.ts:563-571`.

`packages/subagents/package.json` declares:

```json
"pi": {
  "extensions": ["./src/extension/index.ts"],
  "skills": ["./skills"],
  "prompts": ["./prompts"]
}
```

and the required files exist at:

- `packages/subagents/skills/tdd/SKILL.md`
- `packages/subagents/skills/browser/SKILL.md`

### 2.2 The Problem

`@bastani/subagents` builtin skills are discoverable by the main chat ResourceLoader but not by the subagent resolver when the current cwd is the repository root or a normal project directory.

Investigation command run from repo root:

```bash
bun -e 'import { resolveSkills, discoverAvailableSkills, clearSkillCache } from "./packages/subagents/src/agents/skills.ts"; clearSkillCache(); const res=resolveSkills(["tdd","browser"], process.cwd()); console.log(JSON.stringify({resolved: res.resolved.map(s=>s.name), missing: res.missing, available: discoverAvailableSkills(process.cwd()).filter(s=>["tdd","browser"].includes(s.name))}, null, 2));'
```

Observed result:

```json
{
    "resolved": [],
    "missing": ["tdd", "browser"],
    "available": []
}
```

Root cause: `packages/subagents/src/agents/skills.ts:317-327` does not include Atomic host builtin package paths. It can find `@bastani/subagents` skills only if:

- cwd is `packages/subagents`, so `extractSkillPathsFromPackageRoot(cwd, "project-package")` applies;
- `@bastani/subagents` is installed under a scanned npm root;
- settings explicitly reference the package or skill paths.

That diverges from main chat behavior, where `DefaultResourceLoader` receives `builtinPackagePaths` and loads the package’s `pi.skills` resources.

No prior review findings were provided for this first iteration. No direct `#1087` reference was found in repo specs/docs during investigation; the supplied issue description is the authoritative issue context.

## 3. Goals and Non-Goals

### 3.1 Functional Goals

1. From repo root, resolving `tdd` and `browser` through `packages/subagents/src/agents/skills.ts` succeeds and resolves to `packages/subagents/skills`.
2. Foreground subagent runs using builtin `debugger` no longer warn `Skills not found: tdd, browser` solely because the skills are builtin package resources.
3. Async single and async chain execution benefit automatically because they already call `resolveSkillsWithFallback()`.
4. Preserve existing project/user/settings/package skill discovery behavior.
5. Preserve precedence: project/user skill definitions continue to override builtin definitions by name.
6. Keep the `subagent` orchestration skill unavailable for ordinary child injection, as currently enforced in `resolveSkills()`.
7. Add TDD regression tests before implementation using Bun commands only.
8. Avoid build outputs, generated dist files, and broad refactors.

### 3.2 Non-Goals (Out of Scope)

1. Do not rewrite subagent execution or child process spawning.
2. Do not replace the subagent resolver with a full `DefaultResourceLoader` instance in this iteration.
3. Do not change the `debugger` agent’s declared `skills: tdd, browser`.
4. Do not alter `--no-skills` semantics or introduce new user-facing configuration.
5. Do not enable injection of the `subagent` orchestration skill into normal child agents.
6. Do not publish packages or modify release automation.
7. Do not introduce `dist/`, `outDir`, `tsconfig.build.json`, or any build artifact.
8. Do not use Node/npm/yarn/pnpm development commands; validation must use Bun.

## 4. Proposed Solution (High-Level Design)

Add builtin package skill paths to `packages/subagents/src/agents/skills.ts` as a low-priority skill source.

Implementation shape:

1. Import Atomic’s exported `getBuiltinPackagePaths` from `@bastani/atomic`.
2. Add an internal helper, e.g. `collectBuiltinPackageSkillPaths()`, that:
    - calls `getBuiltinPackagePaths()`;
    - iterates each returned package root;
    - uses the existing `extractSkillPathsFromPackageRoot(packageRoot, "builtin", true)`;
    - returns `SkillSearchPath[]`.
3. Insert that helper into `buildSkillPaths(cwd)` after project/user/settings/package discovery sources or anywhere before dedupe, relying on the existing `SOURCE_PRIORITY.builtin = 100` to keep builtin definitions lowest priority.
4. Keep `resolveSkillsWithFallback()`, `buildSkillInjection()`, foreground execution, and async execution unchanged unless tests reveal a missed call site.

This makes subagent resolution use the same builtin package root discovery as main chat while retaining the current resolver’s lightweight synchronous filesystem model.

### 4.1 System Architecture Diagram

```mermaid
flowchart TD
  User[User asks main Atomic chat<br/>to run debugger subagent]
  MainCLI[packages/coding-agent/src/main.ts]
  BuiltinPaths[getBuiltinPackagePaths()<br/>packages/coding-agent/src/core/builtin-packages.ts]
  ResourceLoader[DefaultResourceLoader<br/>packages/coding-agent/src/core/resource-loader.ts]
  MainSkills[Main chat skills list<br/>tdd/browser visible]

  SubagentTool[@bastani/subagents extension<br/>packages/subagents/src/extension/index.ts]
  AgentDef[debugger.md<br/>skills: tdd, browser]
  SkillResolver[Subagent skill resolver<br/>packages/subagents/src/agents/skills.ts]
  BuiltinSkillRoots[NEW: builtin package pi.skills roots<br/>packages/subagents/skills]
  ExistingRoots[Existing roots<br/>project/user/settings/installed packages]
  Injection[buildSkillInjection()<br/>&lt;skill name=\"tdd\"&gt;...]
  Foreground[foreground execution.ts]
  Async[async-execution.ts]
  Child[Child Atomic/Pi process]

  User --> MainCLI
  MainCLI --> BuiltinPaths
  BuiltinPaths --> ResourceLoader
  ResourceLoader --> MainSkills

  MainCLI --> SubagentTool
  SubagentTool --> AgentDef
  AgentDef --> SkillResolver
  SkillResolver --> ExistingRoots
  BuiltinPaths --> BuiltinSkillRoots
  BuiltinSkillRoots --> SkillResolver
  SkillResolver --> Injection
  Injection --> Foreground
  Injection --> Async
  Foreground --> Child
  Async --> Child
```

### 4.2 Architectural Pattern

This is a minimal Adapter/Facade-style alignment:

- `getBuiltinPackagePaths()` remains the single source of truth for host builtin package roots.
- `packages/subagents/src/agents/skills.ts` adapts those package roots into its existing `SkillSearchPath` model.
- The resolver’s existing priority and cache mechanisms remain intact.

This avoids a larger dependency inversion refactor while still eliminating the divergent builtin package discovery path.

### 4.3 Key Components

| Component                                                                          | Responsibility                                                               | Technology Stack                           | Justification                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `packages/subagents/src/agents/skills.ts`                                          | Resolve requested subagent skills, cache results, build prompt injection     | TypeScript, Node fs/path APIs, Bun runtime | Primary bug location; currently omits host builtin package paths |
| `getBuiltinPackagePaths()` in `packages/coding-agent/src/core/builtin-packages.ts` | Locate bundled first-party package roots in source, dist, and binary layouts | TypeScript                                 | Existing main-chat source of truth for builtin package roots     |
| `packages/subagents/agents/debugger.md`                                            | Declares `skills: tdd, browser`                                              | Markdown + YAML frontmatter                | Reproduction target for issue #1087                              |
| `packages/subagents/skills/*/SKILL.md`                                             | Builtin skill content to inject into child prompts                           | Agent Skills standard markdown             | Required builtin resources already shipped by package metadata   |
| `packages/subagents/src/runs/foreground/execution.ts`                              | Inject resolved skills into foreground child system prompts                  | TypeScript                                 | Should benefit via unchanged resolver call                       |
| `packages/subagents/src/runs/background/async-execution.ts`                        | Inject resolved skills into async single and chain child prompts             | TypeScript                                 | Should benefit via unchanged resolver call                       |
| `test/unit/subagents-skills.test.ts` (new)                                         | Regression tests for builtin subagent skill resolution and precedence        | `bun:test`, `node:assert/strict`           | Direct TDD coverage for issue #1087                              |
| `test/unit/coding-agent-builtin-workflows.test.ts` (optional update)               | Existing builtin package ResourceLoader coverage                             | `bun:test`                                 | Can assert main loader also exposes `tdd` and `browser`          |

## 5. Detailed Design

### 5.1 API Interfaces

No public API change is required.

Proposed internal helper in `packages/subagents/src/agents/skills.ts`:

```ts
function collectBuiltinPackageSkillPaths(): SkillSearchPath[] {
    return getBuiltinPackagePaths().flatMap((packageRoot) =>
        extractSkillPathsFromPackageRoot(packageRoot, "builtin", true),
    );
}
```

Proposed integration point:

```ts
function buildSkillPaths(cwd: string): SkillSearchPath[] {
    const skillPaths: SkillSearchPath[] = [
        ...existingProjectSkillPaths,
        ...existingUserSkillPaths,
        ...collectInstalledPackageSkillPaths(cwd),
        ...collectSettingsPackageSkillPaths(cwd),
        ...extractSkillPathsFromPackageRoot(cwd, "project-package"),
        ...collectSettingsSkillPaths(cwd),
        ...collectBuiltinPackageSkillPaths(),
    ];

    // existing path dedupe remains
}
```

The helper should be best-effort. If builtin package discovery returns no paths, normal project/user/settings discovery still works.

No changes are expected to:

- `resolveSkills()`
- `resolveSkillsWithFallback()`
- `buildSkillInjection()`
- foreground/async execution signatures
- CLI/tool schemas

### 5.2 Data Model / Schema

Existing types remain sufficient:

```ts
export type SkillSource =
    | "project"
    | "user"
    | "project-package"
    | "user-package"
    | "project-settings"
    | "user-settings"
    | "extension"
    | "builtin"
    | "unknown";

interface SkillSearchPath {
    path: string;
    source: SkillSource;
}
```

`"builtin"` already exists in `SkillSource` and `SOURCE_PRIORITY` at `packages/subagents/src/agents/skills.ts:55-65`, with lower priority than project/user/package sources. No schema migration is needed.

### 5.3 Algorithms and State Management

Algorithm after the fix:

1. Caller requests skills from run options or agent config:
    - `debugger.md` declares `tdd, browser`.
2. Execution path calls `resolveSkillsWithFallback(skillNames, primaryCwd, fallbackCwd)`.
3. Resolver calls `buildSkillPaths(cwd)`.
4. `buildSkillPaths(cwd)` gathers:
    - existing project skill dirs;
    - existing user skill dirs;
    - existing installed/settings package skill dirs;
    - current cwd package `pi.skills`;
    - existing settings skill paths;
    - new builtin package `pi.skills` roots from `getBuiltinPackagePaths()`.
5. Filesystem scan discovers `packages/subagents/skills/tdd/SKILL.md` and `packages/subagents/skills/browser/SKILL.md`.
6. Name dedupe uses `chooseHigherPrioritySkill()`:
    - project/user definitions still win;
    - builtin definitions fill gaps.
7. `resolveSkills()` reads and strips frontmatter.
8. `buildSkillInjection()` appends skill contents to the child system prompt.
9. Missing warnings are emitted only for genuinely unresolved non-`subagent` skills.

State/caching:

- Keep `loadSkillsCache` with the existing 5-second TTL.
- Builtin package scanning occurs only when the cache refreshes.
- `clearSkillCache()` continues to reset both file and loaded-skill caches for tests.

## 6. Alternatives Considered

| Option                                                                                                | Pros                                                                                                                                                                               | Cons                                                                                                                                                          | Reason for Rejection                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Add builtin package roots to `packages/subagents/src/agents/skills.ts` via `getBuiltinPackagePaths()` | Minimal; reuses main chat builtin root discovery; preserves resolver API; fixes foreground and async paths together; works in source/dist/binary layouts already handled by Atomic | Adds another dependency on `@bastani/atomic` export in a file that already imports config helpers from it                                                     | Recommended: best balance of robustness and minimal change                                                              |
| Hard-code `packages/subagents/skills` relative to `import.meta.url`                                   | Very small and directly fixes `tdd`/`browser`; independent of ResourceLoader internals                                                                                             | Less aligned with main chat; can miss dist/binary edge cases unless carefully implemented; only covers the current package, not future builtin package skills | Rejected as primary approach because issue asks to use the same builtin package discovery or host builtin package paths |
| Pass `builtinPackagePaths` through extension/runtime options into every resolver call                 | Explicit dependency injection; testable; avoids importing discovery in resolver                                                                                                    | Requires API plumbing through extension context, foreground executor options, async config serialization, and runner setup; more invasive                     | Rejected for iteration 1 because current execution paths already centralize skill resolution in one module              |
| Instantiate `DefaultResourceLoader` inside subagent skill resolution                                  | Exact parity with main chat skill loading and metadata                                                                                                                             | Async loader in a synchronous resolver path; heavier; risks recursion/side effects; may alter precedence and include session-level options unintentionally    | Rejected as too broad for a minimal bug fix                                                                             |
| Duplicate builtin skills into user/project config during install                                      | Simple runtime lookup afterward                                                                                                                                                    | Mutates user state; creates stale copies; breaks package update semantics; security and support burden                                                        | Rejected as an anti-pattern                                                                                             |

## 7. Cross-Cutting Concerns

### 7.1 Security and Privacy

The change adds only Atomic-owned builtin package skill roots already loaded by the main ResourceLoader. It does not add arbitrary new paths or network access.

Security-sensitive constraints:

- Preserve `SUBAGENT_ORCHESTRATION_SKILL = "subagent"` behavior in `resolveSkills()` so normal child agents still cannot inject the parent-only subagent orchestration skill.
- Preserve user/project precedence so teams can override or disable behavior through existing configuration patterns.
- Do not inject builtin skills unless requested by agent config or explicit run options.

### 7.2 Observability Strategy

Existing observability remains adequate:

- Missing skills currently surface as `Skills not found: ...` warnings in foreground and async run results.
- `discoverAvailableSkills(cwd)` feeds selection/doctor surfaces and should include `tdd` and `browser` after the fix, while still filtering `subagent`.
- `clearSkillCache()` supports deterministic tests.

No new telemetry is proposed.

### 7.3 Scalability and Capacity Planning

Builtin package count is small: `workflows`, `subagents`, `mcp`, `web-access`, and `intercom` per `packages/coding-agent/src/core/builtin-packages.ts:26-57`. Adding their `pi.skills` roots to the scan is negligible compared with existing user/project/package scans.

The existing 5-second `loadSkillsCache` avoids repeated filesystem traversal during bursts of subagent launches.

## 8. Migration, Rollout, and Testing

### 8.1 Deployment Strategy

1. Add failing unit tests first.
2. Implement the resolver change in `packages/subagents/src/agents/skills.ts`.
3. Optionally update `test/unit/coding-agent-builtin-workflows.test.ts` to assert ResourceLoader exposes `tdd` and `browser`.
4. Add a `packages/subagents/CHANGELOG.md` `[Unreleased] -> Fixed` entry if this implementation stage includes changelog updates.
5. Validate with Bun:
    - `bun test test/unit/subagents-skills.test.ts`
    - `bun test test/unit/coding-agent-builtin-workflows.test.ts`
    - `bun run typecheck`
    - broader `bun run test:unit` if time allows.

No data migration, package publish, or build output is required.

### 8.2 Data Migration Plan

No data migration is required.

Existing user/project settings, skill directories, package installs, and cache behavior remain compatible.

### 8.3 Test Plan

TDD red tests to add before implementation:

1. **Builtin resolver regression from repo root**
    - File: `test/unit/subagents-skills.test.ts`
    - Arrange: `clearSkillCache()`, `const repoRoot = resolve(".")`.
    - Act: `resolveSkills(["tdd", "browser"], repoRoot)`.
    - Assert:
        - `missing` is empty.
        - resolved names include `tdd` and `browser`.
        - resolved paths end with:
            - `packages/subagents/skills/tdd/SKILL.md`
            - `packages/subagents/skills/browser/SKILL.md`

2. **Injection content regression**
    - Act: `buildSkillInjection(resolvedSkills)`.
    - Assert:
        - contains `<skill name="tdd">`;
        - contains `<skill name="browser">`;
        - does not include YAML frontmatter delimiters at the beginning of injected content.

3. **Precedence preservation**
    - Arrange: temp cwd with `.agents/skills/tdd/SKILL.md`.
    - Act: `resolveSkills(["tdd"], tempCwd)`.
    - Assert: resolved path is the temp project skill, not builtin `packages/subagents/skills/tdd/SKILL.md`.

4. **Unavailable orchestration skill remains unavailable**
    - Act: `resolveSkills(["subagent"], repoRoot)`.
    - Assert: `missing` includes `subagent`, even though the builtin package contains `packages/subagents/skills/subagent/SKILL.md`.

5. **Optional ResourceLoader parity assertion**
    - Extend `test/unit/coding-agent-builtin-workflows.test.ts`.
    - Existing test already checks builtin resources load.
    - Add `tdd` and `browser` to expected builtin skill names, alongside current checks for `subagent` and `intercom`.

6. **Optional package metadata hardening**
    - Extend `test/unit/package-metadata.test.ts`.
    - Assert `subagentsPackageJson.pi.skills` equals `["./skills"]`.
    - Assert expected skill files exist under `packages/subagents/skills`.

## 9. Open Questions / Unresolved Issues

1. Should subagent skill resolution eventually consume a ResourceLoader-provided skill registry instead of maintaining a parallel resolver? `[OWNER: Atomic Subagents maintainers]`
2. Should main chat `--no-skills` suppress subagent agent-config skill injection, or are these separate concepts by design? `[OWNER: Atomic product/CLI maintainers]`
3. Should builtin package skill discovery include all builtin packages returned by `getBuiltinPackagePaths()` or only `@bastani/subagents`? This RFC recommends all builtin package skill roots for parity, but product ownership should confirm. `[OWNER: Atomic Subagents maintainers]`
4. Should async result metadata include skill source paths/sources for debugging future “skill not found” reports? `[OWNER: Atomic observability maintainers]`
