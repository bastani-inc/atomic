# Partition 1: `packages/atomic-sdk/` Core Patterns

## Overview

The atomic-sdk (44k LOC) is the workflow execution engine and TUI layer. It concentrates all tmux, Claude/Copilot/OpenCode SDK coupling, and orchestrator logic. Entry point is `src/index.ts` (public barrel), with internal layering: `define-workflow.ts` → `runtime/executor.ts` → `runtime/panel.tsx` (OpenTUI), plus provider adapters under `src/providers/`.

---

## Pattern 1: Workflow Definition and Compilation

**Where:** `packages/atomic-sdk/src/define-workflow.ts:217-348`

**What:** Chainable WorkflowBuilder pattern with `.for()` agent narrowing, `.run()` entry point registration, and `.compile()` sealing into immutable WorkflowDefinition.

```typescript
export class WorkflowBuilder<
  A extends AgentType = AgentType,
  I extends AnyInputs = AnyInputs,
> {
  /** @internal Brand for detection across package boundaries */
  readonly __brand = "WorkflowBuilder" as const;
  private readonly options: WorkflowOptions<I>;
  private runFn: ((ctx: WorkflowContext<A, I>) => Promise<void>) | null = null;
  private agentValue: AgentType | null = null;

  for<B extends AgentType>(agent: B): WorkflowBuilder<B, I> {
    const next = new WorkflowBuilder<B, I>(this.options as WorkflowOptions<I>);
    next.agentValue = agent;
    next.runFn = this.runFn as ((ctx: WorkflowContext<B, I>) => Promise<void>) | null;
    return next;
  }

  run(fn: (ctx: WorkflowContext<A, I>) => Promise<void>): this {
    if (this.runFn) {
      throw new Error("run() can only be called once per workflow.");
    }
    this.runFn = fn;
    return this;
  }

  compile(): WorkflowDefinition<A, I> {
    // ... validation ...
    const definition: WorkflowDefinition<A, I> = {
      __brand: "WorkflowDefinition" as const,
      name: this.options.name,
      agent: this.agentValue as A,
      description: this.options.description ?? "",
      inputs,
      minSDKVersion: this.options.minSDKVersion ?? null,
      source: this.options.source,
      run: runFn,
    };
    _compiledWorkflowRegistry.push(definition as unknown as WorkflowDefinition);
    return definition;
  }
}
```

**Variations / call-sites:**
- `src/define-workflow.ts:376-391` — `defineWorkflow()` factory entry point with auto-captured stack-based source path
- `src/define-workflow.ts:48-65` — `_captureCallerPath()` stack frame extraction for source path auto-population

---

## Pattern 2: Agent Type and Provider Abstraction

**Where:** `packages/atomic-sdk/src/types.ts:1-101`

**What:** Discriminated union type system mapping each agent (claude/copilot/opencode) to its SDK client/session types and stage options. All provider SDKs' native types are imported directly (no re-definitions).

```typescript
import type { SessionEvent } from "@github/copilot-sdk";
import type { SessionPromptResponse } from "@opencode-ai/sdk/v2";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
} from "@github/copilot-sdk";
import type {
  OpencodeClient,
  Session as OpencodeSession,
} from "@opencode-ai/sdk/v2";
import type {
  ClaudeClientWrapper,
  ClaudeSessionWrapper,
} from "./providers/claude.ts";

type ClientOptionsMap = {
  opencode: { directory?: string; experimental_workspaceID?: string };
  copilot: Omit<CopilotClientOptions, "cliUrl">;
  claude: { chatFlags?: string[] };
};

type SessionOptionsMap = {
  opencode: {
    parentID?: string;
    title?: string;
    workspaceID?: string;
    permission?: import("@opencode-ai/sdk/v2").PermissionRuleset;
  };
  copilot: Partial<CopilotSessionConfig>;
  claude: Record<string, never>;
};

type ClientMap = {
  opencode: OpencodeClient;
  copilot: CopilotClient;
  claude: ClaudeClientWrapper;
};

type SessionMap = {
  opencode: OpencodeSession;
  copilot: CopilotSession;
  claude: ClaudeSessionWrapper;
};

export type StageClientOptions<A extends AgentType> = ClientOptionsMap[A];
export type StageSessionOptions<A extends AgentType> = SessionOptionsMap[A];
export type ProviderClient<A extends AgentType> = ClientMap[A];
export type ProviderSession<A extends AgentType> = SessionMap[A];
```

**Variations / call-sites:**
- `src/types.ts:29-50` — public barrel exports of all type interfaces
- `src/runtime/executor.ts:26-50` — imports these discriminated types for executor's stage dispatch

---

## Pattern 3: Workflow Context and Stage Spawning

**Where:** `packages/atomic-sdk/src/types.ts:296-394`

**What:** Two-tier context model: WorkflowContext (top-level, no session fields) and SessionContext (nested, with paneId/save/sessionId). Both expose `.stage()` to spawn sub-sessions with typed inputs, client options, and callback.

```typescript
export interface SessionContext<
  A extends AgentType = AgentType,
  I extends readonly WorkflowInput[] = readonly WorkflowInput[],
> {
  client: ProviderClient<A>;
  session: ProviderSession<A>;
  inputs: InputsOf<I>;
  agent: A;
  transcript(ref: SessionRef): Promise<Transcript>;
  getMessages(ref: SessionRef): Promise<SavedMessage[]>;
  save: SaveTranscript;
  sessionDir: string;
  paneId: string;
  sessionId: string;
  stage<T = void>(
    options: SessionRunOptions,
    clientOpts: StageClientOptions<A>,
    sessionOpts: StageSessionOptions<A>,
    run: (ctx: SessionContext<A, I>) => Promise<T>,
  ): Promise<SessionHandle<T>>;
}

export interface WorkflowContext<
  A extends AgentType = AgentType,
  I extends readonly WorkflowInput[] = readonly WorkflowInput[],
> {
  inputs: InputsOf<I>;
  agent: A;
  stage<T = void>(
    options: SessionRunOptions,
    clientOpts: StageClientOptions<A>,
    sessionOpts: StageSessionOptions<A>,
    run: (ctx: SessionContext<A, I>) => Promise<T>,
  ): Promise<SessionHandle<T>>;
  transcript(ref: SessionRef): Promise<Transcript>;
  getMessages(ref: SessionRef): Promise<SavedMessage[]>;
}
```

**Variations / call-sites:**
- `src/types.ts:275-289` — `SessionRunOptions` with `headless?: boolean` flag for background spawn
- `src/types.ts:265-272` — `SessionHandle<T>` return type with `.id`, `.name`, `.result`

---

## Pattern 4: Tmux Session and Pane Lifecycle

**Where:** `packages/atomic-sdk/src/runtime/executor.ts:659-800`

**What:** Top-level `executeWorkflow()` creates a tmux session in the atomic socket, spawns an orchestrator pane via self-exec, and optionally attaches or detaches. All tmux operations routed through `tmux.*` module.

```typescript
export async function executeWorkflow(
  options: WorkflowRunOptions,
): Promise<{ id: string; tmuxSessionName: string }> {
  const {
    definition,
    agent,
    inputs = {},
    projectRoot = process.cwd(),
    detach = false,
    pathToAtomicExecutable,
  } = options;

  const dispatcher = resolveDispatcher({ override: pathToAtomicExecutable });
  const workflowRunId = generateId();
  const tmuxSessionName = `atomic-wf-${agent}-${definition.name}-${workflowRunId}`;
  const sessionsBaseDir = join(getSessionsBaseDir(), workflowRunId);
  await ensureDir(sessionsBaseDir);

  const agentEnv: Record<string, string> = {
    ...AGENT_CLI[agent].envVars,
    ...claudeTempEnv,
    ...providerOverrides.envVars,
    ATOMIC_AGENT: agent,
  };
  const sessionEnv = buildTmuxEnv(agentEnv);

  const launcherPath = join(sessionsBaseDir, `orchestrator.${launcherExt}`);
  const inputsB64 = Buffer.from(JSON.stringify(inputs)).toString("base64");
  const workflowSource = definition.source;

  const orchestratorCmd = buildSelfExecCommand({
    dispatcher,
    subcommand: "_orchestrator-entry",
    args: [definition.name, agent, inputsB64, workflowSource],
  });

  const orchPaneId = tmux.createSession(
    tmuxSessionName,
    orchestratorCmd,
    sessionsBaseDir,
    sessionEnv,
  );

  spawnAttachedFooter(orchPaneId, undefined, tmuxSessionName);

  if (detach) {
    return { id: workflowRunId, tmuxSessionName };
  }

  return spawnMuxAttach(tmuxSessionName);
}
```

**Variations / call-sites:**
- `src/runtime/executor.ts:51-52` — `import * as tmux from "./tmux.ts"` and `spawnMuxAttach` from tmux module
- `src/runtime/executor.ts:785-800` — env/launcher setup and orchestrator pane creation
- `src/runtime/executor.ts:318-340` — WorkflowRunOptions interface with `detach` flag

---

## Pattern 5: Tmux Module Primitives

**Where:** `packages/atomic-sdk/src/runtime/tmux.ts:17-100`

**What:** Low-level tmux operations: session/pane creation, window management, binary resolution. Atomic socket isolation via `SOCKET_NAME = "atomic"`. Multiplexer detection (tmux on Unix, psmux/pmux on Windows).

```typescript
export const SOCKET_NAME = "atomic";
const CONFIG_PATH = tmuxConfPath;

export type TmuxResult =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string };

let resolvedMuxBinary: string | null | undefined;

export function getMuxBinary(): string | null {
  if (resolvedMuxBinary !== undefined) return resolvedMuxBinary;

  const pathOpt = { PATH: process.env.PATH ?? "" };
  for (const candidate of requiredMuxBinaryCandidatesForPlatform()) {
    if (Bun.which(candidate, pathOpt)) {
      resolvedMuxBinary = candidate;
      return resolvedMuxBinary;
    }
  }

  resolvedMuxBinary = null;
  return resolvedMuxBinary;
}

export function resetMuxBinaryCache(): void {
  resolvedMuxBinary = undefined;
}

export function isTmuxInstalled(): boolean {
  return getMuxBinary() !== null;
}

export function isInsideTmux(): boolean {
  return process.env.TMUX !== undefined || process.env.PSMUX !== undefined;
}
```

**Variations / call-sites:**
- `src/runtime/tmux.ts:140-310` — `createSession()`, `createWindow()`, `selectWindow()`, `killWindow()`, `killSession()`
- `src/runtime/tmux.ts:341-400` — pane-level ops: `capturePane()`, `getPanePid()`, `sendKeys()`, `respawnPane()`

---

## Pattern 6: Provider Adapter: Claude

**Where:** `packages/atomic-sdk/src/providers/claude.ts:1-100`

**What:** Claude SDK query abstraction. Wraps `@anthropic-ai/claude-agent-sdk` with tmux-based interactive session delivery (send-keys polling + pane capture verification), session tracking map, and CLI flag marshalling.

```typescript
import {
  getSessionMessages,
  query as sdkQuery,
  type SessionMessage,
  type SDKUserMessage,
  type Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";

interface PaneState {
  claudeSessionId: string;
  claudeStarted: boolean;
  chatFlags: string[];
}

const initializedPanes = new Map<string, PaneState>();

export async function createClaudeSession(
  paneId: string,
  chatFlags: string[],
  ...
): Promise<string> {
  const claudeSessionId = randomUUID();
  initializedPanes.set(paneId, {
    claudeSessionId,
    claudeStarted: false,
    chatFlags,
  });
  return claudeSessionId;
}

export async function clearClaudeSession(paneId: string): Promise<void> {
  // Release marker, signal Stop hook, wait for in-flight marker dir drain
  const state = initializedPanes.get(paneId);
  if (!state) return;
  
  // ... release logic ...
  
  initializedPanes.delete(paneId);
}
```

**Variations / call-sites:**
- `src/providers/claude.ts:200-300` — `claudeQuery()` with tmux send-keys + capture-pane polling loops
- `src/providers/claude.ts:300-400` — `buildClaudeResumeArgs()` for offload/resume
- `src/providers/claude-stop-hook.ts` — 18k LOC for Hook workflow setup, session tracking, subagent tree marshalling

---

## Pattern 7: Provider Adapter: Copilot

**Where:** `packages/atomic-sdk/src/providers/copilot.ts:75-180`

**What:** Copilot SDK initialization and validation. Detects non-native shims (Node shebangs, npm-loader wrappers) in PATH to avoid passing them to the SDK. Merges system messages and builds resume args.

```typescript
export function isCopilotShim(candidate: string): boolean {
  if (JS_EXT_RE.test(candidate)) return true;
  if (candidate.includes(`node_modules${sep}.bin`) || candidate.includes("node_modules/.bin")) {
    const real = safeRealpath(candidate);
    if (JS_EXT_RE.test(real)) return true;
  }
  const header = readCandidateHeader(candidate);
  if (header === null) return false;
  return NODE_SHEBANG_RE.test(header) || header.includes(NPM_LOADER_MARKER);
}

export function resolveCopilotCliPath(
  resolveCommandPath: CommandPathResolver = getCommandPath,
): string | undefined {
  const envPath = process.env["COPILOT_CLI_PATH"];
  if (envPath) return envPath;
  const primary = resolveCommandPath("copilot");
  if (primary === null) return undefined;
  if (!isCopilotShim(primary)) return primary;
  // ... fallback search ...
}

export function buildCopilotResumeArgs(
  meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
): string[] {
  return ["--ui-server", "--port", "0", `--resume=${meta.agentSessionId}`, ...meta.chatFlags];
}
```

**Variations / call-sites:**
- `src/providers/copilot.ts:127-138` — `copilotSdkLaunchOptions()` builds CopilotClientOptions with env + cliPath
- `src/providers/copilot.ts:199-214` — `validateCopilotWorkflow` regex-based source validator

---

## Pattern 8: Provider Adapter: OpenCode

**Where:** `packages/atomic-sdk/src/providers/opencode.ts:43-95`

**What:** OpenCode headless environment scoping and resume arg builder. Headless stages set `OPENCODE_CLIENT=sdk` to exclude the interactive `question` tool; ref-counted nesting to handle parallel stages.

```typescript
export const HEADLESS_OPENCODE_CLIENT_ID = "sdk";

let headlessEnvDepth = 0;
let headlessEnvHadPrior = false;
let headlessEnvPrior: string | undefined;

export async function withHeadlessOpencodeEnv<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (headlessEnvDepth === 0) {
    headlessEnvHadPrior = Object.prototype.hasOwnProperty.call(
      process.env,
      "OPENCODE_CLIENT",
    );
    headlessEnvPrior = process.env.OPENCODE_CLIENT;
  }
  headlessEnvDepth++;
  try {
    process.env.OPENCODE_CLIENT = HEADLESS_OPENCODE_CLIENT_ID;
    return await fn();
  } finally {
    headlessEnvDepth--;
    if (headlessEnvDepth === 0) {
      if (headlessEnvHadPrior) process.env.OPENCODE_CLIENT = headlessEnvPrior;
      else delete process.env.OPENCODE_CLIENT;
    }
  }
}

export function buildOpencodeResumeArgs(
  meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
): string[] {
  return ["--port", "0", "--session", meta.agentSessionId, ...meta.chatFlags];
}
```

**Variations / call-sites:**
- `src/providers/opencode.ts:100-115` — `validateOpenCodeWorkflow` source validator

---

## Pattern 9: Offload Manager State Machine

**Where:** `packages/atomic-sdk/src/runtime/offload-manager.ts:1-58`

**What:** Resume metadata persistence and cleanup. Filters spawn environment (allowlist secrets, denies token keys), manages per-stage mutexes for concurrent writes, and tracks offload/resume lifecycle events for telemetry.

```typescript
const SPAWN_ENV_EXACT_ALLOW: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "PATH",
  "HOME",
  "LANG",
  "SHELL",
]);
const SPAWN_ENV_PREFIX_ALLOW: readonly string[] = ["ATOMIC_", "LC_", "OPENCODE_", "COPILOT_"];
const SPAWN_ENV_EXACT_DENY: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);
const SPAWN_ENV_SUFFIX_DENY = /_(API_KEY|AUTH_TOKEN|SECRET|TOKEN|PASSWORD)$/i;

export function filterSpawnEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SPAWN_ENV_EXACT_DENY.has(key) || SPAWN_ENV_SUFFIX_DENY.test(key)) continue;
    if (SPAWN_ENV_EXACT_ALLOW.has(key) || SPAWN_ENV_PREFIX_ALLOW.some((p) => key.startsWith(p))) {
      result[key] = value;
    }
  }
  return result;
}

const _stageMutex = new Map<string, Promise<void>>();

const _resumeDefaults: Omit<OffloadResumeMetadata, "schemaVersion"> = {
  agentSessionId: "",
  tmuxSessionName: "",
  tmuxWindowName: "",
  spawnEnv: {},
  spawnCwd: "",
  chatFlags: [],
  lastPrompt: "",
  lastSeenAt: 0,
  offloadedAt: null,
};
```

**Variations / call-sites:**
- `src/runtime/offload-manager.ts:80-200` — `persistResume()` async, serializes metadata.json
- `src/runtime/offload-manager.ts:200-400` — `OffloadManager` class constructor and resume orchestration

---

## Pattern 10: Orchestrator Entry Point

**Where:** `packages/atomic-sdk/src/runtime/orchestrator-entry.ts:57-75`

**What:** Dual-mode workflow resolution: compiled-binary (registry lookup by name+agent) vs. dev/installed-package (dynamic import by source). Validates `WorkflowDefinition` brand before invoking `runOrchestrator()`.

```typescript
export async function resolveWorkflowDefinition(
  sourcePath: string,
  workflowName: string,
  agent: AgentType,
): Promise<WorkflowDefinition> {
  const mod: unknown = await import(sourcePath);

  if (workflowName !== "") {
    const fromHost = lookupLocalWorkflow(workflowName, agent);
    if (fromHost && isWorkflowDefinition(fromHost)) {
      return fromHost;
    }
  }

  const def = (mod as { default?: unknown }).default;
  if (isWorkflowDefinition(def)) return def;

  throw new InvalidWorkflowError(sourcePath);
}

export async function runOrchestratorWithDefinition(
  def: WorkflowDefinition,
  inputsB64: string,
): Promise<void> {
  const inputs = decodeInputs(inputsB64);
  await runOrchestrator(def, inputs);
}
```

**Variations / call-sites:**
- `src/runtime/orchestrator-entry.ts:130-180` — `runOrchestratorEntry()` full entry point with error boundary

---

## Pattern 11: Orchestrator Execution and Panel

**Where:** `packages/atomic-sdk/src/runtime/executor.ts:2290-2390`

**What:** Main orchestrator loop: creates OrchestratorPanel (OpenTUI), wires panel store mutations to `status.json`, builds OffloadManager with tmux+provider deps, and invokes the user's workflow callback with WorkflowContext.

```typescript
export async function runOrchestrator(
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<void> {
  const { workflowRunId, tmuxSessionName, agent, cwd } = validateOrchestratorEnv();

  setExecutorTelemetrySinks({
    telemetry: getProductionTelemetrySink(workflowRunId),
  });

  const sessionsBaseDir = join(getSessionsBaseDir(), workflowRunId);
  await ensureDir(sessionsBaseDir);

  const panel = await OrchestratorPanel.create({
    tmuxSession: tmuxSessionName,
  });

  let snapshotPending = false;
  const persistSnapshot = (): void => {
    if (snapshotPending) return;
    snapshotPending = true;
    queueMicrotask(() => {
      snapshotPending = false;
      const snap = panel.getSnapshot();
      void writeSnapshot(
        sessionsBaseDir,
        buildSnapshot({
          workflowRunId,
          tmuxSession: tmuxSessionName,
          ...snap,
        }),
      );
    });
  };
  const unsubscribePanel = panel.subscribe(persistSnapshot);
  persistSnapshot();

  let shutdownCalled = false;
  const shutdown = (exitCode = 0) => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    unsubscribePanel();
    void writeSnapshot(sessionsBaseDir, buildSnapshot({ ... }));
    panel.destroy();
    try {
      tmux.killSession(tmuxSessionName);
    } catch {}
    process.exitCode = exitCode;
  };

  const offloadManager = createOffloadManager({
    panelStore: panel.getPanelStore(),
    tmux: {
      killWindow: tmux.killWindow,
      createWindow: async (session, window, command, cwd, envVars) => {
        tmux.createWindow(session, window, command, cwd, envVars);
      },
      selectWindow: async (session, window) => {
        tmux.selectWindow(`${session}:${window}`);
      },
    },
    providers: { ... },
  });

  const ctx: WorkflowContext<AgentType> = {
    inputs: parsedInputs,
    agent,
    stage: async (opts, clientOpts, sessionOpts, run) => {
      // Delegate to offloadManager.spawnSession
    },
    transcript: ...,
    getMessages: ...,
  };

  await definition.run(ctx);
  shutdown(0);
}
```

**Variations / call-sites:**
- `src/runtime/executor.ts:2500-2600` — provider-specific session creation wiring
- `src/runtime/panel.tsx` — OpenTUI orchestrator pane component (re-export from components/)

---

## Pattern 12: Registry Immutable Accumulation

**Where:** `packages/atomic-sdk/src/registry.ts:58-115`

**What:** Type-safe registry with immutable accumulation. Each `register(wf)` returns a new Registry with updated generic type. Validates workflows at registration time (provider-specific source warnings).

```typescript
class RegistryImpl<T extends Record<string, WorkflowDefinition | ExternalWorkflow>> {
  private readonly map: ReadonlyMap<string, WorkflowDefinition | ExternalWorkflow>;

  constructor(map: ReadonlyMap<string, WorkflowDefinition | ExternalWorkflow>) {
    this.map = map;
  }

  register<W extends RegistrableWorkflow>(
    wf: W,
  ): Registry<T & Record<`${W["agent"]}/${W["name"]}`, W>> {
    const key = `${wf.agent}/${wf.name}` as `${W["agent"]}/${W["name"]}`;

    if (this.map.has(key)) {
      throw new Error(
        `[atomic] Duplicate workflow registration: "${key}" is already registered.`,
      );
    }

    validateAtRegistration(wf);

    const next = new Map(this.map);
    next.set(key, wf);
    return new RegistryImpl<T & Record<`${W["agent"]}/${W["name"]}`, W>>(next) as Registry<
      T & Record<`${W["agent"]}/${W["name"]}`, W>
    >;
  }

  upsert(
    wf: RegistrableWorkflow,
    onOverride?: (prior: WorkflowDefinition | ExternalWorkflow) => void,
  ): Registry<T> {
    const key = `${wf.agent}/${wf.name}`;
    const prior = this.map.get(key);
    if (prior !== undefined && onOverride) {
      onOverride(prior);
    }
    validateAtRegistration(wf);
    const next = new Map(this.map);
    next.set(key, wf);
    return new RegistryImpl<T>(next) as Registry<T>;
  }

  list(): readonly (WorkflowDefinition | ExternalWorkflow)[] {
    return Object.freeze(Array.from(this.map.values()));
  }

  resolve(name: string, agent: AgentType): WorkflowDefinition | ExternalWorkflow | undefined {
    return this.map.get(`${agent}/${name}`);
  }
}

export function createRegistry(): Registry<Record<string, never>> {
  return new RegistryImpl<Record<string, never>>(new Map()) as Registry<Record<string, never>>;
}
```

**Variations / call-sites:**
- `src/registry.ts:18-40` — validator dispatch table mapping agent → validator function
- `src/registry.ts:150-153` — factory entry point

---

## Agent SDK Dependencies

All agent SDK imports are **load-bearing** and concentrated in these files:

- **Claude**: `src/providers/claude.ts` (61k LOC including hooks), `src/providers/claude-stop-hook.ts` (18k), `src/providers/claude-inflight-hook.ts` (12k)
  - Imports: `@anthropic-ai/claude-agent-sdk` for `SessionMessage`, `getSessionMessages()`, tmux-based query
  
- **Copilot**: `src/providers/copilot.ts` (14k)
  - Imports: `@github/copilot-sdk` for `CopilotClient`, `CopilotSession`, `SessionEvent` types
  
- **OpenCode**: `src/providers/opencode.ts` (4k)
  - Imports: `@opencode-ai/sdk/v2` for `OpencodeClient`, `createOpencodeClient`, `SessionPromptResponse`

**Tmux dependencies** (core execution path):
- `src/runtime/executor.ts` — ALL session/window/pane lifecycle
- `src/runtime/tmux.ts` — raw tmux primitives + binary detection
- `src/runtime/offload-manager.ts` — offload/resume state and metadata persistence
- `src/runtime/port-discovery.ts` — TCP port polling for agent readiness probes

**Removable for pi-coding-agent rewrite:**
- All provider/*.ts adapters (claude/copilot/opencode) — replace with pi-specific integration
- All tmux.ts primitives — replace with pi's pane/session API
- Stop hooks, inflight hooks — replace with pi's hook system
- Offload/resume serialization — adapt to pi's session persistence model

---

## Summary

This partition reveals the load-bearing seams for the rewrite:

1. **defineWorkflow + WorkflowBuilder** — The DSL is **agent-agnostic** (can be ported verbatim)
2. **WorkflowContext/SessionContext types** — **Agent-agnostic**, but `.stage()` dispatch must invert to use pi's session/pane APIs
3. **Registry pattern** — **Agent-agnostic** accumulation (keep as-is)
4. **Orchestrator entry + executor** — **Tmux-coupled**, must be rewritten to spawn pi panes instead
5. **Provider adapters (claude/copilot/opencode)** — **Agent-specific**, completely removed in pi rewrite
6. **Offload/resume** — **Tmux-coupled**, must be adapted to pi's session model

The rewrite inverts the architecture: instead of a separate orchestrator pane coordinating separate agent CLI panes in tmux, pi-coding-agent's chat TUI becomes the orchestrator, with workflow stages spawned as dynamically-loaded extensions or subagents in pi's native pane system.
