# Testing Infrastructure Patterns — Atomic CLI Test Suite

**Scope**: `tests/` (52 files, 10,395 LOC)  
**Focus**: Test organization, spawning real processes (tmux, agents, binaries), env isolation, SDK integration, unit vs integration patterns

---

## Pattern 1: Environment Isolation via Save/Restore with beforeEach/afterEach

**Where**: `tests/sdk/runtime/tmux.test.ts:34-46`  
**What**: Shared test helper that saves/restores critical environment variables across test suites to prevent test pollution.

```typescript
function withEnvRestore(vars: string[]) {
    const saved: Record<string, string | undefined> = {};
    for (const v of vars) saved[v] = process.env[v];

    afterEach(() => {
        for (const v of vars) {
            if (saved[v] !== undefined) {
                process.env[v] = saved[v];
            } else {
                delete process.env[v];
            }
        }
    });
}

describe("isInsideTmux", () => {
    withEnvRestore(["TMUX", "PSMUX"]);

    test("returns true when TMUX env var is set", () => {
        process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
        delete process.env.PSMUX;
        expect(isInsideTmux()).toBe(true);
    });
});
```

**Variations / call-sites**:

- `tests/services/config/settings.test.ts:19-34` — Environment isolation with `ATOMIC_SETTINGS_HOME`
- `tests/services/config/scm-sync.test.ts:20-35` — Temp directory + env var restore pattern
- `tests/commands/cli/chat/chat-integration.test.ts:35-49` — Full process.env save/restore via `saveEnv()` / `restoreEnv()`

---

## Pattern 2: Temporary Directory Sandboxing for File System Tests

**Where**: `tests/services/config/settings.test.ts:21-34`  
**What**: Uses `mkdtemp()` to create isolated temp dirs, restores env vars after cleanup, prevents filesystem pollution.

```typescript
let tmpDir: string;
let previousSettingsHome: string | undefined;

beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "settings-test-"));
    previousSettingsHome = process.env.ATOMIC_SETTINGS_HOME;
    process.env.ATOMIC_SETTINGS_HOME = tmpDir;
});

afterEach(async () => {
    if (previousSettingsHome === undefined) {
        delete process.env.ATOMIC_SETTINGS_HOME;
    } else {
        process.env.ATOMIC_SETTINGS_HOME = previousSettingsHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
});

function settingsPath(): string {
    return join(tmpDir, ".atomic", "settings.json");
}
```

**Variations / call-sites**:

- `tests/services/config/scm-sync.test.ts:21-26` — Creates multiple temp directories per test
- `tests/ci/onboarding.test.ts:71-77` — Multi-sandbox pattern with project + settings homes
- `tests/ci/onboarding.test.ts:61-69` — Generous cleanup timeout (120s) for heavy fixtures

---

## Pattern 3: Spawning External Binaries with spawnSync for E2E Tests

**Where**: `tests/ci/onboarding.test.ts:103-126`  
**What**: Spawns compiled `atomic` binary in isolated sandbox with full env injection to test preflight initialization and onboarding file generation.

```typescript
function runPreflight(agent: string, sandbox: Sandbox): PreflightResult {
    const result = spawnSync(
        getBinaryPath(),
        ["chat", "-a", agent, "--preflight-only"],
        {
            cwd: sandbox.projectRoot,
            env: {
                ...process.env,
                ATOMIC_SETTINGS_HOME: sandbox.settingsHome,
                HOME: sandbox.settingsHome,
                USERPROFILE: sandbox.settingsHome,
                XDG_CACHE_HOME: join(sandbox.settingsHome, ".cache"),
                LOCALAPPDATA: join(sandbox.settingsHome, "AppData", "Local"),
            },
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 120_000,
        },
    );
    return {
        exitCode: result.status ?? -1,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
    };
}
```

**Variations / call-sites**:

- `tests/ci/_helpers/binary.ts:39-59` — Build binary on demand via `ensureBinary()` + memoization
- `tests/ci/_helpers/binary.ts:21-28` — Platform-aware binary path resolution (`.exe` on Windows)
- `tests/ci/onboarding.test.ts:44-45` — Gate test with `RUN_CI_E2E=1` environment variable
- `tests/ci/onboarding.test.ts:176-212` — Parameterized test loop over agents: `for (const [agent, expectedFiles] of Object.entries(EXPECTED))`

---

## Pattern 4: Platform Mocking via Object.defineProperty for Cross-Platform Tests

**Where**: `tests/commands/cli/chat/buildLauncherScript.test.ts:8-23`  
**What**: Patches `process.platform` dynamically to test bash and PowerShell launcher script generation without spawning separate processes.

```typescript
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(
    process,
    "platform",
);

function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, "platform", {
        value: p,
        configurable: true,
    });
}

afterAll(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
        Object.defineProperty(
            process,
            "platform",
            ORIGINAL_PLATFORM_DESCRIPTOR,
        );
    }
});

describe("buildLauncherScript – bash (posix)", () => {
    beforeEach(() => setPlatform("linux"));
    afterEach(() => setPlatform("linux"));

    test("returns ext=sh", () => {
        const { ext } = buildLauncherScript("/usr/bin/agent", [], "/home/user");
        expect(ext).toBe("sh");
    });
});

describe("buildLauncherScript – PowerShell (win32)", () => {
    beforeEach(() => setPlatform("win32"));
    afterEach(() => setPlatform("linux"));
    // PowerShell-specific tests...
});
```

**Variations / call-sites**:

- `tests/sdk/runtime/tmux.test.ts:57-71` — `withMockPlatform()` helper for scoped platform mocking
- `tests/sdk/runtime/tmux.test.ts:113-151` — Fake command creation with `writeFakeCommand()` to simulate PATH resolution

---

## Pattern 5: Memoized Binary Build with Shared Helper

**Where**: `tests/ci/_helpers/binary.ts:30-59`  
**What**: Centralized binary resolution + on-demand build to avoid multiple compilation calls across test suites; holds on exit until cleanup.

```typescript
let binaryReady = false;

export function ensureBinary(): void {
    if (binaryReady) return;

    const binaryPath = getBinaryPath();
    if (existsSync(binaryPath)) {
        binaryReady = true;
        return;
    }

    const buildScript = join(
        REPO_ROOT,
        "packages",
        "atomic",
        "script",
        "build.ts",
    );
    const result = spawnSync("bun", [buildScript], {
        stdio: "inherit",
        cwd: REPO_ROOT,
        timeout: 600_000,
    });

    if (result.status !== 0) {
        throw new Error(
            `build.ts exited with status ${result.status ?? "null"}`,
        );
    }
    binaryReady = true;
}

export function getBinaryPath(): string {
    const target = hostTarget();
    const meta = TARGETS.find((t) => t.name === target);
    if (!meta) {
        throw new Error(`Unknown host target "${target}". Update TARGETS.`);
    }
    return join(
        REPO_ROOT,
        "packages",
        "atomic",
        "dist",
        target,
        "bin",
        `atomic${meta.ext ?? ""}`,
    );
}
```

**Variations / call-sites**:

- `tests/ci/onboarding.test.ts:40-41` — Invokes `ensureBinary()` at test start, reuses across parameterized loop

---

## Pattern 6: Environment Builders with Three Variants (Launcher/Spawn/Tmux)

**Where**: `tests/commands/cli/chat/chat-integration.test.ts:55-88, 130-217, 226-313`  
**What**: Three distinct env-building functions with different secret-handling and inheritance strategies:

- `buildLauncherEnv()` — minimal, excludes secrets, terminal keys only
- `buildSpawnEnv()` — full inheritance, includes secrets (intentional)
- `buildTmuxEnv()` — full inheritance, strips tmux context vars

```typescript
describe("buildLauncherEnv – launcher script safety", () => {
    test("excludes GH_TOKEN from inherited env", () => {
        const base: NodeJS.ProcessEnv = {
            GH_TOKEN: "ghp_secret",
            LANG: "en_US.UTF-8",
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
        };
        const env = buildLauncherEnv({}, base);
        expect("GH_TOKEN" in env).toBe(false);
    });

    test("exports normalized LANG, LC_ALL, LC_CTYPE, TERM, COLORTERM", () => {
        const base: NodeJS.ProcessEnv = { LANG: "C", TERM: "dumb" };
        const env = buildLauncherEnv({}, base);
        expect(env["LANG"]).toBe("en_US.UTF-8");
        expect(env["COLORTERM"]).toBe("truecolor");
    });
});

describe("buildTmuxEnv – tmux session env", () => {
    test("strips outer-tmux/psmux identifiers so the new pane doesn't reuse the caller's TMUX/TMUX_PANE", () => {
        const env = buildTmuxEnv(
            {},
            {
                TMUX: "/tmp/tmux-1000/default,123,0",
                TMUX_PANE: "%5",
                PSMUX: "/tmp/psmux/default,123,0",
            },
        );
        expect("TMUX" in env).toBe(false);
        expect("PSMUX" in env).toBe(false);
    });
});
```

**Variations / call-sites**:

- `tests/commands/cli/chat/chat-integration.test.ts:305-312` — Symmetry test: `buildTmuxEnv` and `buildSpawnEnv` both expose full shell env

---

## Pattern 7: Pure Function Unit Tests with Deterministic Inputs

**Where**: `tests/sdk/runtime/tmux.test.ts:244-276`  
**What**: Focused pure-function tests for parsing/normalization; no env setup, highly readable test names.

```typescript
describe("normalizeTmuxCapture", () => {
    test("collapses whitespace to single spaces", () => {
        expect(normalizeTmuxCapture("hello   world")).toBe("hello world");
    });

    test("strips carriage returns", () => {
        expect(normalizeTmuxCapture("hello\r\nworld")).toBe("hello world");
    });

    test("collapses newlines to spaces", () => {
        expect(normalizeTmuxCapture("line1\nline2\nline3")).toBe(
            "line1 line2 line3",
        );
    });

    test("trims leading and trailing whitespace", () => {
        expect(normalizeTmuxCapture("  hello  ")).toBe("hello");
    });
});

describe("parseSessionName", () => {
    test("parses chat session with agent", () => {
        const result = parseSessionName("atomic-chat-claude-a1b2c3d4");
        expect(result).toEqual({ type: "chat", agent: "claude" });
    });

    test("parses workflow session with hyphenated workflow name", () => {
        const result = parseSessionName(
            "atomic-wf-opencode-my-cool-workflow-a1b2c3d4",
        );
        expect(result).toEqual({ type: "workflow", agent: "opencode" });
    });
});
```

**Variations / call-sites**:

- `tests/sdk/runtime/tmux.test.ts:328-375` — 14 parsing variants in a single describe block
- `tests/services/config/scm-sync.test.ts:55-82` — Pure function flags builder: `copilotScmDisableFlags()`

---

## Pattern 8: State Mutation Tests with Tracking via GraphFrontierTracker

**Where**: `tests/sdk/runtime/graph-inference.test.ts:4-92`  
**What**: Tests dag execution order via `onSpawn()` / `onSettle()` calls; verifies parallel fan-out, fan-in, and nested scope isolation.

```typescript
describe("GraphFrontierTracker", () => {
    test("sequential chain: each stage depends on the previous", () => {
        const t = new GraphFrontierTracker("orchestrator");

        // await ctx.stage("a")
        expect(t.onSpawn()).toEqual(["orchestrator"]);
        t.onSettle("a");

        // await ctx.stage("b")
        expect(t.onSpawn()).toEqual(["a"]);
        t.onSettle("b");

        // await ctx.stage("c")
        expect(t.onSpawn()).toEqual(["b"]);
        t.onSettle("c");
    });

    test("parallel fan-out: siblings share the same parent", () => {
        const t = new GraphFrontierTracker("orchestrator");

        // await ctx.stage("a")
        expect(t.onSpawn()).toEqual(["orchestrator"]);
        t.onSettle("a");

        // Promise.all([ctx.stage("b"), ctx.stage("c")])
        expect(t.onSpawn()).toEqual(["a"]); // b
        expect(t.onSpawn()).toEqual(["a"]); // c
    });

    test("ralph loop: sequential chain across iterations", () => {
        const t = new GraphFrontierTracker("orchestrator");

        // Iteration 1
        expect(t.onSpawn()).toEqual(["orchestrator"]); // planner-1
        t.onSettle("planner-1");
        expect(t.onSpawn()).toEqual(["planner-1"]); // orchestrator-1
        t.onSettle("orchestrator-1");
        // Iteration 2
        expect(t.onSpawn()).toEqual(["orchestrator-1"]); // planner-2
    });
});
```

**Variations / call-sites**:

- Tests ralph-loop (planner → orchestrator → reviewer cycles)
- Tests nested scopes with independent trackers
- Tests diamond patterns (sequential → parallel → fan-in)

---

## Pattern 9: Parameterized Agent Testing with describe.skipIf Gate

**Where**: `tests/ci/onboarding.test.ts:176-212`  
**What**: Loop over agent configurations with parameterized test names; skip entire suite if `RUN_CI_E2E !== "1"`.

```typescript
const isE2EEnabled = process.env.RUN_CI_E2E === "1";

const EXPECTED: Record<string, readonly ExpectedFile[]> = {
    claude: [
        { destination: ".mcp.json", hasTopLevelKey: "mcpServers" },
        { destination: ".claude/settings.json" },
        { destination: "~/.claude/settings.json" },
    ],
    copilot: [{ destination: ".mcp.json", hasTopLevelKey: "mcpServers" }],
    opencode: [{ destination: ".opencode/opencode.json" }],
} as const;

describe.skipIf(!isE2EEnabled)("onboarding preflight (compiled binary)", () => {
    for (const [agent, expectedFiles] of Object.entries(EXPECTED)) {
        test(`${agent}: preflight materialises every declared onboarding file`, async () => {
            ensureBinary();
            const sandbox = await createSandbox(agent);
            const result = runPreflight(agent, sandbox);
            expect(result.exitCode).toBe(0);
            for (const file of expectedFiles) {
                const path = resolveSandboxPath(file.destination, sandbox);
                expect(existsSync(path)).toBe(true);
            }
        }, 120_000); // 120s timeout for binary startup
    }
});

test.skipIf(isE2EEnabled)(
    "onboarding preflight [skip when RUN_CI_E2E unset]",
    () => {
        expect(true).toBe(true);
    },
);
```

**Variations / call-sites**:

- `tests/ci/onboarding.test.ts:217-222` — Marker test for CI dashboards when E2E disabled

---

## Pattern 10: Async File I/O Tests with Helper Functions

**Where**: `tests/services/config/scm-sync.test.ts:37-49, 119-126`  
**What**: Async helpers to read/write JSON config files; tests use helpers to keep test code readable.

```typescript
async function writeAtomicConfig(
    projectRoot: string,
    config: Record<string, unknown>,
): Promise<void> {
    const dir = join(projectRoot, ".atomic");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), JSON.stringify(config));
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
}

async function writeClaudeSettings(
    projectRoot: string,
    settings: Record<string, unknown>,
): Promise<void> {
    const dir = join(projectRoot, ".claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
}

describe("syncScmMcpServers — Claude settings", () => {
    test("adds azure-devops to disabledMcpjsonServers when scm is github", async () => {
        const projectRoot = join(tmpDir, "claude-gh");
        await mkdir(projectRoot, { recursive: true });
        await writeAtomicConfig(projectRoot, { scm: "github" });
        await writeClaudeSettings(projectRoot, {});

        await syncScmMcpServers(projectRoot);

        const settings = await readJsonFile(
            join(projectRoot, ".claude", "settings.json"),
        );
        expect(settings.disabledMcpjsonServers).toEqual(["azure-devops"]);
    });
});
```

**Variations / call-sites**:

- `tests/services/config/scm-sync.test.ts:276-284` — OpenCode variant of config writer
- `tests/services/config/settings.test.ts:36-49` — Per-test helper for settings path + read/write

---

## Pattern 11: SDK Host Consumer Fixture

**Where**: `tests/fixtures/sdk-host-consumer/index.ts`  
**What**: Standalone executable fixture that imports SDK directly; used to test that SDK exports work in host mode.

```typescript
#!/usr/bin/env bun
import {
    defineWorkflow,
    hostLocalWorkflows,
    type WorkflowDefinition,
} from "@bastani/atomic-sdk";

const wf = defineWorkflow({
    name: "demo-wf",
    description: "Demo workflow for SDK host integration test",
    inputs: [],
})
    .for("claude")
    .run(async (_ctx) => {
        // no-op run for fixture purposes
    })
    .compile() as unknown as WorkflowDefinition;

await hostLocalWorkflows([wf]);

// user main() continues here when not invoked under atomic
console.log("user main ran");
```

**Variations / call-sites**:

- `tests/fixtures/sdk-compiled-consumer/` — Compiled TypeScript consumer for build verification

---

## Pattern 12: YAML Workflow Validation Tests

**Where**: `tests/ci/publish-workflow-shape.test.ts:1-33`  
**What**: Validates GitHub Actions workflow structure via YAML parsing; checks for bare `npm publish` anti-patterns.

```typescript
import { test, expect } from "bun:test";
import { parse } from "yaml";
import { join } from "node:path";

const WORKFLOW_PATH = join(
    import.meta.dir,
    "../../.github/workflows/publish.yml",
);

test("publish workflow invokes per-package publish scripts", async () => {
    const wf = parse(await Bun.file(WORKFLOW_PATH).text());
    const steps = wf.jobs.publish.steps as Array<{
        run?: string;
        uses?: string;
    }>;
    const runs = steps.map((s) => s.run ?? "").filter(Boolean);
    expect(
        runs.some((r) => r.includes("bun packages/atomic/script/publish.ts")),
    ).toBe(true);
    expect(
        runs.some((r) =>
            r.includes("bun packages/atomic-sdk/script/publish.ts"),
        ),
    ).toBe(true);
});

test("no job runs bare 'npm publish' from the repo root", async () => {
    const wf = parse(await Bun.file(WORKFLOW_PATH).text());
    const offenders: string[] = [];
    for (const [jobName, job] of Object.entries(
        wf.jobs as Record<string, { steps?: Array<{ run?: string }> }>,
    )) {
        for (const step of job.steps ?? []) {
            const cmd = step.run ?? "";
            const lines = cmd.split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (/^npm\s+publish\b/.test(trimmed) && !/\bcd\s+/.test(line)) {
                    offenders.push(`${jobName}: ${trimmed}`);
                }
            }
        }
    }
    expect(offenders).toEqual([]);
});
```

**Variations / call-sites**:

- CI validation tests for asset bundle, MCP server config, import constraints

---

## Summary

The test suite demonstrates these key patterns:

1. **Environment Isolation**: Comprehensive save/restore of env vars + temp dir sandboxing prevents test pollution
2. **Process Spawning**: `spawnSync()` for external binaries with full env injection; binary memoization prevents rebuilds
3. **Platform Mocking**: Dynamic `process.platform` patching for cross-platform code testing without subprocess overhead
4. **Three Env Builders**: Distinct `buildLauncherEnv()` / `buildSpawnEnv()` / `buildTmuxEnv()` with different secret/inheritance strategies
5. **Pure Unit Tests**: Heavy use of pure functions (parsing, normalization, flags) with no setup required
6. **State Mutation via Callbacks**: `GraphFrontierTracker` tests verify DAG execution order with `onSpawn()` / `onSettle()` calls
7. **Parameterized E2E Tests**: Agent loop + gating via environment variable; generous 120s timeouts for binary startup
8. **Async File I/O**: Helper functions for JSON reads/writes keep test code DRY and readable
9. **SDK Fixtures**: Standalone consumer files verify SDK exports in host and compiled modes
10. **Workflow Validation**: YAML parsing + regex checks guard against CI/CD anti-patterns
11. **Integration vs Unit**: Clear separation — unit tests for parsing/logic are fast; E2E tests spawn real binaries (gated)
