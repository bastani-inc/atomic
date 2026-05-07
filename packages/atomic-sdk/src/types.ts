/**
 * Workflow SDK Types
 *
 * Uses native SDK types directly — no re-definitions.
 */

import type { SessionEvent } from "@github/copilot-sdk";
import type { SessionPromptResponse } from "@opencode-ai/sdk/v2";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

// Provider SDK types for the type maps
import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  SessionConfig as CopilotSessionConfig,
} from "@github/copilot-sdk";
import type {
  OpencodeClient,
  Session as OpencodeSession,
} from "@opencode-ai/sdk/v2";
import type {
  ClaudeClientWrapper,
  ClaudeSessionWrapper,
} from "./providers/claude.ts";
import type { AgentKey } from "./services/config/definitions.ts";

/**
 * Supported agent identifier — alias of {@link AgentKey} so that
 * `isValidAgent(x): x is AgentKey` narrows to the same nominal type used
 * everywhere in the SDK (workflow definitions, ctx.stage, etc).
 */
export type AgentType = AgentKey;

// ─── Provider type maps ─────────────────────────────────────────────────────

/**
 * Maps each agent to the client init options the user passes to `ctx.stage()`.
 * Auto-injected fields (`cliUrl`, `baseUrl`, `paneId`) are omitted.
 */
type ClientOptionsMap = {
  opencode: { directory?: string; experimental_workspaceID?: string };
  copilot: Omit<CopilotClientOptions, "cliUrl">;
  claude: { chatFlags?: string[] };
};

/**
 * Maps each agent to the session create options the user passes to `ctx.stage()`.
 * - OpenCode: `client.session.create()` body params
 * - Copilot: `client.createSession()` config (onPermissionRequest defaults to approveAll)
 * - Claude: no per-session options — delivery is driven entirely by Stop hooks.
 */
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

/** Maps each agent to the `s.client` type provided in the stage callback. */
type ClientMap = {
  opencode: OpencodeClient;
  copilot: CopilotClient;
  claude: ClaudeClientWrapper;
};

/** Maps each agent to the `s.session` type provided in the stage callback. */
type SessionMap = {
  opencode: OpencodeSession;
  copilot: CopilotSession;
  claude: ClaudeSessionWrapper;
};

/** Client init options for `ctx.stage()`, resolved by agent type. */
export type StageClientOptions<A extends AgentType> = ClientOptionsMap[A];

/** Session create options for `ctx.stage()`, resolved by agent type. */
export type StageSessionOptions<A extends AgentType> = SessionOptionsMap[A];

/** The `s.client` type in a stage callback, resolved by agent type. */
export type ProviderClient<A extends AgentType> = ClientMap[A];

/** The `s.session` type in a stage callback, resolved by agent type. */
export type ProviderSession<A extends AgentType> = SessionMap[A];

// Re-export provider types for convenience
export type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  CopilotSessionConfig,
  OpencodeClient,
  OpencodeSession,
  ClaudeClientWrapper,
  ClaudeSessionWrapper,
};

// ─── Validation ─────────────────────────────────────────────────────────────

/** A source validation warning emitted by provider-specific workflow validators. */
export interface ValidationWarning {
  rule: string;
  message: string;
}

/** A declarative validation rule: pattern to match + warning to emit. */
export interface ValidationRule {
  pattern: RegExp;
  rule: string;
  message: string;
}

/**
 * Run a set of regex-based validation rules against workflow source code.
 * Returns a warning for each matching pattern.
 */
export function validateWorkflowSource(
  source: string,
  rules: readonly ValidationRule[],
): ValidationWarning[] {
  // Strip single-line comments to avoid false positives from patterns
  // that appear only in comments (e.g., a comment mentioning claudeQuery).
  const stripped = source.replace(/\/\/.*$/gm, "");
  const warnings: ValidationWarning[] = [];
  for (const { pattern, rule, message } of rules) {
    if (pattern.test(stripped)) {
      warnings.push({ rule, message });
    }
  }
  return warnings;
}

/**
 * Create a provider-specific workflow validator from a set of rules.
 * Eliminates boilerplate — each provider file only needs to declare its rules.
 */
export function createProviderValidator(
  rules: readonly ValidationRule[],
): (source: string) => ValidationWarning[] {
  return (source) => validateWorkflowSource(source, rules);
}

// ─── Workflow input schemas ─────────────────────────────────────────────────

/**
 * Supported field types for a workflow's declared inputs.
 *
 * - `"string"`  — single-line free-form input (short values, identifiers, paths)
 * - `"text"`    — multi-line free-form input (long prose, prompts, specs)
 * - `"enum"`    — one of a fixed list of allowed `values`
 * - `"integer"` — whole number; parsed to `number` in `ctx.inputs`
 */
export type WorkflowInputType = "string" | "text" | "enum" | "integer";

/**
 * A declared input for a workflow. When a workflow provides an `inputs`
 * array, the CLI materialises one `--<name>` flag per input (and the
 * interactive picker renders one field per input) so users can pass
 * structured values rather than a single free-form prompt.
 *
 * Leaving `inputs` unset (or empty) signals that the workflow consumes a
 * single free-form prompt instead — the legacy
 * `atomic workflow -n <name> -a <agent> "prompt"` form.
 */
export interface WorkflowInput {
  /** Field name — also the CLI flag (`--<name>`) and form field identifier. */
  name: string;
  /** Input kind — see {@link WorkflowInputType}. */
  type: WorkflowInputType;
  /** Whether the field must be non-empty before the workflow can run. */
  required?: boolean;
  /** Short human description shown as the field caption. */
  description?: string;
  /** Placeholder text shown when the field is empty. */
  placeholder?: string;
  /**
   * Default value pre-filled into the field. Enums use this to pick
   * their initial value. Integer inputs accept either a `number` or its
   * decimal string representation.
   */
  default?: string | number;
  /** Allowed values — required when `type` is `"enum"`. */
  values?: readonly string[];
}

/**
 * Map a {@link WorkflowInputType} to the runtime value type observed in
 * `ctx.inputs`. Integer inputs are parsed to `number` at the executor
 * boundary; everything else stays a `string`.
 */
export type WorkflowInputValue<T extends WorkflowInputType> =
  T extends "integer" ? number : string;

/**
 * Compute the typed `ctx.inputs` shape from a workflow's declared input
 * schema. Each declared field becomes an optional key whose value type
 * is determined by {@link WorkflowInputValue}.
 *
 * Free-form workflows (no declared schema) fall back to a loose
 * string-keyed record so authors can still read `ctx.inputs.prompt`.
 */
export type InputsOf<I extends readonly WorkflowInput[]> =
  // Non-literal schema (default `I = readonly WorkflowInput[]`) or empty
  // tuple — no type-level info about individual fields, so fall back to a
  // loose string record that preserves the prior free-form behaviour.
  WorkflowInput extends I[number]
    ? Record<string, string | undefined>
    : I[number] extends never
      ? Record<string, string | undefined>
      : {
          [K in I[number]["name"]]?: WorkflowInputValue<
            Extract<I[number], { name: K }>["type"]
          >;
        };

// ─── Core types ─────────────────────────────────────────────────────────────

/**
 * A transcript from a completed session.
 * Provides both the file path and rendered text content.
 */
export interface Transcript {
  /** Absolute path to the transcript file on disk */
  path: string;
  /** The transcript content (assistant text extracted from messages) */
  content: string;
}

/**
 * A saved message from any provider, stored as JSON.
 * Uses native SDK types directly.
 */
export type SavedMessage =
  | { provider: "copilot"; data: SessionEvent }
  | { provider: "opencode"; data: SessionPromptResponse }
  | { provider: "claude"; data: SessionMessage };

/**
 * Save native message objects from the provider SDK.
 *
 * - **Copilot**: `s.save(await s.session.getMessages())`
 * - **OpenCode**: `s.save(result.data)` — the full `{ info, parts }` response
 * - **Claude**: `s.save(sessionId)` — auto-reads via `getSessionMessages()`
 */
export interface SaveTranscript {
  /** Save Copilot SessionEvent[] from session.getMessages() */
  (messages: SessionEvent[]): Promise<void>;
  /** Save OpenCode prompt response `{ info, parts }` from session.prompt().data */
  (response: SessionPromptResponse): Promise<void>;
  /** Save Claude messages — pass the session ID to auto-read transcript */
  (claudeSessionId: string): Promise<void>;
}

/** A reference to a completed session — either a handle or a session name string. */
export type SessionRef = string | SessionHandle<unknown>;

/**
 * Handle returned by `ctx.stage()`. Used for type-safe transcript references
 * and carries the callback's return value.
 */
export interface SessionHandle<T = void> {
  /** The session's unique name */
  readonly name: string;
  /** The session's generated UUID */
  readonly id: string;
  /** The value returned by the session callback */
  readonly result: T;
}

/**
 * Options for spawning a session via `ctx.stage()`.
 */
export interface SessionRunOptions {
  /** Unique name for this session (used for transcript references and graph display) */
  name: string;
  /** Human-readable description */
  description?: string;
  /**
   * When true, spawn the CLI server as a background child process (Bun.spawn)
   * instead of creating a tmux window. The provider client/session are still
   * auto-created but the stage is invisible in the graph. Useful for
   * Copilot/OpenCode SDKs that need a server but don't need a visible TUI.
   */
  headless?: boolean;
}

/**
 * Context provided to each session's callback.
 * Created by `ctx.stage(opts, clientOpts, sessionOpts, fn)` — the callback
 * receives this as its argument with pre-initialized `client` and `session`.
 */
export interface SessionContext<
  A extends AgentType = AgentType,
  I extends readonly WorkflowInput[] = readonly WorkflowInput[],
> {
  /** Provider-specific SDK client (auto-created by runtime) */
  client: ProviderClient<A>;
  /** Provider-specific session (auto-created by runtime) */
  session: ProviderSession<A>;
  /**
   * Structured inputs for this workflow run. Populated from CLI flags
   * (`--<name>=<value>`) or the interactive picker.
   *
   * When the workflow declares an `inputs` schema, only the declared
   * field names are valid keys — accessing undeclared fields is a
   * compile-time error. Each field's value type is determined by its
   * declared `type` (integer inputs surface as `number`). Free-form
   * workflows (no declared schema) allow any key.
   */
  inputs: InputsOf<I>;
  /** Which agent is running */
  agent: A;
  /**
   * Get a completed session's transcript as rendered text.
   * Accepts a SessionHandle (recommended) or session name string.
   */
  transcript(ref: SessionRef): Promise<Transcript>;
  /**
   * Get a completed session's raw native messages.
   * Accepts a SessionHandle (recommended) or session name string.
   */
  getMessages(ref: SessionRef): Promise<SavedMessage[]>;
  /**
   * Save this session's output for subsequent sessions.
   * Accepts native SDK message objects only.
   */
  save: SaveTranscript;
  /** Path to this session's storage directory on disk */
  sessionDir: string;
  /** tmux pane ID for this session */
  paneId: string;
  /** Session UUID */
  sessionId: string;
  /**
   * Spawn a nested sub-session with its own tmux window and graph node.
   * The sub-session is a child of this session in the graph.
   * The callback's return value is available as `handle.result`.
   */
  stage<T = void>(
    options: SessionRunOptions,
    clientOpts: StageClientOptions<A>,
    sessionOpts: StageSessionOptions<A>,
    run: (ctx: SessionContext<A, I>) => Promise<T>,
  ): Promise<SessionHandle<T>>;
}

/**
 * Top-level context provided to the workflow's `.run()` callback.
 * Does not have session-specific fields (paneId, save, etc.).
 */
export interface WorkflowContext<
  A extends AgentType = AgentType,
  I extends readonly WorkflowInput[] = readonly WorkflowInput[],
> {
  /**
   * Structured inputs for this workflow run. Populated from CLI flags
   * (`--<name>=<value>`) or the interactive picker.
   *
   * When the workflow declares an `inputs` schema, only the declared
   * field names are valid keys — accessing undeclared fields is a
   * compile-time error. Each field's value type is determined by its
   * declared `type` (integer inputs surface as `number`). Free-form
   * workflows (no declared schema) allow any key.
   */
  inputs: InputsOf<I>;
  /** Which agent is running */
  agent: A;
  /**
   * Spawn a session with its own tmux window and graph node.
   * The runtime manages the full lifecycle: create client → create session →
   * run callback → cleanup. The callback's return value is available as
   * `handle.result`.
   */
  stage<T = void>(
    options: SessionRunOptions,
    clientOpts: StageClientOptions<A>,
    sessionOpts: StageSessionOptions<A>,
    run: (ctx: SessionContext<A, I>) => Promise<T>,
  ): Promise<SessionHandle<T>>;
  /**
   * Get a completed session's transcript as rendered text.
   * Accepts a SessionHandle (recommended) or session name string.
   */
  transcript(ref: SessionRef): Promise<Transcript>;
  /**
   * Get a completed session's raw native messages.
   * Accepts a SessionHandle (recommended) or session name string.
   */
  getMessages(ref: SessionRef): Promise<SavedMessage[]>;
}

/**
 * Options for defining a workflow.
 */
export interface WorkflowOptions<
  I extends readonly WorkflowInput[] = readonly WorkflowInput[],
> {
  /** Unique workflow name */
  name: string;
  /** Human-readable description */
  description?: string;
  /**
   * Absolute path of the workflow source file. Pass `import.meta.path` —
   * the SDK uses this to import the workflow module inside the
   * orchestrator child process. Required: a workflow without `source`
   * cannot be re-imported by the orchestrator and `defineWorkflow`
   * throws at compile time.
   *
   * @example
   * ```typescript
   * defineWorkflow({
   *   name: "hello",
   *   source: import.meta.path, // ← required
   * }).for("claude").run(...).compile();
   * ```
   */
  source: string;
  /**
   * Optional declared inputs. When provided, the CLI materialises one
   * `--<name>` flag per entry and the interactive picker renders one form
   * field per entry. Leave unset to keep the workflow free-form (a single
   * positional prompt argument).
   *
   * Write the array inline so TypeScript can infer literal input names
   * and enforce them on `ctx.inputs`.
   */
  inputs?: I;
  /**
   * Minimum Atomic CLI version this workflow is known to work with.
   *
   * When set, the CLI refuses to load the workflow on an older install
   * and surfaces an actionable "update required" entry in the picker
   * and `atomic workflow list` output instead of silently dropping it.
   *
   * Leave unset (the default) to opt out entirely — the workflow will
   * be treated as compatible with every CLI version. Use this when you
   * consume a new SDK feature (new provider API, a new field on the
   * stage options, etc.) that older installs can't honour.
   *
   * Accepts `MAJOR.MINOR.PATCH` with an optional numeric prerelease
   * (`0.6.0`, `0.6.0-0`). Invalid strings are ignored.
   */
  minSDKVersion?: string;
}

// ─── Registry + WorkflowCli types ───────────────────────────────────────────

/**
 * An external workflow loaded from `settings.json` `workflows` entries.
 *
 * Carries the same user-visible metadata as a `WorkflowDefinition`
 * (name, agent, description, inputs) so it can be passed to `listWorkflows`,
 * picker, and `atomic workflow inputs` without special-casing those surfaces.
 *
 * `source` here is not a file path — it is the subprocess command needed
 * by the dispatcher to invoke the third-party binary via `_atomic-run`.
 */
export interface ExternalWorkflow {
  readonly kind: "external";
  readonly name: string;
  readonly agent: AgentType;
  readonly description?: string;
  readonly inputs: WorkflowInput[];
  readonly source: { command: string; args: string[] };
}

/**
 * Structural constraint for workflows accepted by `Registry.register()`.
 *
 * A discriminated union:
 * - builtin branch: compiled in-process `WorkflowDefinition` (optional `kind?: "builtin"`)
 * - external branch: subprocess-dispatched `ExternalWorkflow` from `settings.json`
 *
 * The builtin branch uses `run: (...args: never[]) => Promise<void>` instead of
 * the full `WorkflowDefinition<A, I>` constraint to avoid contravariance failures
 * under `--strictFunctionTypes`. Type narrowing on the accumulating `T` generic
 * is still preserved via `W["agent"]`/`W["name"]`.
 */
export type RegistrableWorkflow =
  | {
      readonly __brand: "WorkflowDefinition";
      readonly agent: AgentType;
      readonly name: string;
      readonly description: string;
      readonly inputs: readonly WorkflowInput[];
      readonly minSDKVersion: string | null;
      readonly source: string;
      readonly run: (...args: never[]) => Promise<void>;
      readonly kind?: "builtin";
    }
  | ExternalWorkflow;

/**
 * Immutable, chainable registry of workflow entries (builtins + externals).
 *
 * The generic parameter `T` accumulates the registered set as a
 * `Record<"${agent}/${name}", RegistrableWorkflow>` intersection, giving
 * `get()` a typed return without casting.
 */
export type Registry<
  T extends Record<string, WorkflowDefinition | ExternalWorkflow> = Record<
    string,
    WorkflowDefinition | ExternalWorkflow
  >,
> = {
  /**
   * Register a workflow definition. Returns a new Registry with the
   * definition added. Throws if the same `${agent}/${name}` key is
   * already registered.
   */
  register<W extends RegistrableWorkflow>(
    wf: W,
  ): Registry<T & Record<`${W["agent"]}/${W["name"]}`, W>>;

  /**
   * Upsert a workflow definition. Returns a new Registry with the definition
   * added or replaced. Unlike `register()`, does NOT throw on duplicate
   * `(agent, name)` — the new entry silently replaces the existing one.
   *
   * Use this when merging custom/external workflows over builtins where
   * `local > global > builtin` precedence must be honoured. If no entry
   * exists for the key, upsert behaves identically to `register()`.
   *
   * When a prior entry is replaced, the optional `onOverride` callback is
   * called with the previous entry so callers can emit audit logs.
   *
   * @param wf - The workflow definition to register or replace.
   * @param onOverride - Optional callback invoked with the displaced entry.
   */
  upsert(
    wf: RegistrableWorkflow,
    onOverride?: (prior: WorkflowDefinition | ExternalWorkflow) => void,
  ): Registry<T>;

  /**
   * Retrieve a registered definition by its composite key.
   * Compile-time typed based on the accumulated registry type.
   */
  get<K extends keyof T>(key: K): T[K];

  /** Return true if a workflow with the given composite key is registered. */
  has(key: string): boolean;

  /** Return all registered entries (builtins + externals) as a readonly array. */
  list(): readonly (WorkflowDefinition | ExternalWorkflow)[];

  /**
   * Resolve a workflow by name + agent. Composes the composite key
   * internally. Returns `undefined` when not found.
   */
  resolve(name: string, agent: AgentType): WorkflowDefinition | ExternalWorkflow | undefined;
};

/**
 * A compiled workflow definition — the sealed output of defineWorkflow().compile().
 */
export interface WorkflowDefinition<
  A extends AgentType = AgentType,
  I extends readonly WorkflowInput[] = readonly WorkflowInput[],
> {
  readonly __brand: "WorkflowDefinition";
  readonly name: string;
  /** The agent this workflow targets. Set via `.for(agent)` in the builder. */
  readonly agent: A;
  readonly description: string;
  /**
   * Absolute path of the workflow source file (the value of
   * `import.meta.path` at the `defineWorkflow()` call site).
   *
   * The SDK's orchestrator entry script `import()`s this path inside
   * the child process to recover the compiled definition without any
   * reliance on environment variables or the parent CLI's argv.
   */
  readonly source: string;
  /**
   * Declared input schema — empty tuple for free-form workflows.
   * Typed as the builder-supplied `I` so consumers (e.g.
   * `createWorkflowCli(def)`) can derive the narrow `InputsOf<I>` shape
   * without carrying a second generic parameter.
   */
  readonly inputs: I;
  /**
   * Minimum Atomic SDK version required. `null` when the workflow
   * declared no requirement — treated as compatible with every CLI.
   */
  readonly minSDKVersion: string | null;
  /** The workflow's entry point. Called by the executor with a WorkflowContext. */
  // Method signature (not a property) so TypeScript treats `run` as bivariant
  // under --strictFunctionTypes — this allows a WorkflowDefinition<"claude">
  // to be assigned to WorkflowDefinition<AgentType> even though `agent` is
  // narrowed. Property function signatures would be contravariant and reject
  // the assignment. See: https://www.typescriptlang.org/docs/handbook/2/functions.html
  run(ctx: WorkflowContext<A, I>): Promise<void>;
}
