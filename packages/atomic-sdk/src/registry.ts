/**
 * Workflow Registry — immutable, chainable registry of WorkflowDefinition objects.
 *
 * Key scheme: `${agent}/${name}` — each (agent, name) pair is unique.
 * Registering the same key twice throws — no silent overwrites.
 * `register()` is immutable: returns a new Registry, original is unchanged.
 */

import type { AgentType, ExternalWorkflow, Registry, RegistrableWorkflow, WorkflowDefinition } from "./types.ts";
import { validateCopilotWorkflow } from "./providers/copilot.ts";
import { validateOpenCodeWorkflow } from "./providers/opencode.ts";
import { validateClaudeWorkflow } from "./providers/claude.ts";
import type { ValidationWarning } from "./types.ts";

// Registry type is declared in types.ts; re-export it from here for convenience.
export type { Registry };

// ─── Validator dispatch ──────────────────────────────────────────────────────

/** Map agent type to its provider validator. */
const providerValidators: Record<
  AgentType,
  (source: string) => ValidationWarning[]
> = {
  claude: validateClaudeWorkflow,
  opencode: validateOpenCodeWorkflow,
  copilot: validateCopilotWorkflow,
};

/**
 * Run provider-specific source validation for a workflow definition.
 *
 * Derives source text from `wf.run.toString()` — the function body contains
 * the SDK API calls the validators check via regex. Hard failures (thrown
 * errors from the validator itself) propagate; warnings are returned.
 */
function runProviderValidation(wf: WorkflowDefinition): ValidationWarning[] {
  const validator = providerValidators[wf.agent];
  const source = wf.run.toString();
  return validator(source);
}

/**
 * Validate a workflow entry at registration time.
 * External workflows (`kind === "external"`) have no `run` source to inspect —
 * validation is skipped silently. Builtins log warnings via console.warn.
 */
function validateAtRegistration(wf: WorkflowDefinition | ExternalWorkflow): void {
  // ExternalWorkflow has no `run` to inspect — skip provider validation.
  if ("kind" in wf && wf.kind === "external") return;
  const warnings = runProviderValidation(wf as WorkflowDefinition);
  for (const w of warnings) {
    console.warn(
      `[registry] workflow "${wf.agent}/${wf.name}" — ${w.rule}: ${w.message}`,
    );
  }
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Internal implementation — typed separately from the public `Registry<T>`
 * so the accumulating generic can be rebuilt on each `register()` call
 * without leaking the implementation detail.
 */
class RegistryImpl<T extends Record<string, WorkflowDefinition | ExternalWorkflow>> {
  /**
   * Immutable snapshot of registered entries, keyed by `${agent}/${name}`.
   * Values may be builtins (`WorkflowDefinition`) or externals (`ExternalWorkflow`).
   * Consumers discriminate via `entry.kind === "external"` at runtime.
   */
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
        `[atomic] Duplicate workflow registration: "${key}" is already registered. ` +
          `Each (agent, name) pair must be unique.`,
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

  get<K extends keyof T>(key: K): T[K] {
    const entry = this.map.get(key as string);
    if (!entry) {
      throw new Error(`[atomic] Workflow "${String(key)}" is not registered.`);
    }
    return entry as T[K];
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  list(): readonly WorkflowDefinition[] {
    // Cast: callers that need to dispatch on `kind === "external"` do so at
    // runtime; the public Registry type exposes WorkflowDefinition for
    // backwards-compatible callers that only handle builtins.
    return Object.freeze(Array.from(this.map.values())) as readonly WorkflowDefinition[];
  }

  resolve(name: string, agent: AgentType): WorkflowDefinition | undefined {
    // Same cast rationale as list() above.
    return this.map.get(`${agent}/${name}`) as WorkflowDefinition | undefined;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an empty workflow registry.
 *
 * @example
 * ```typescript
 * import { createRegistry } from "@bastani/atomic/workflows";
 * import { myWorkflow } from "./workflows/my-workflow.workflow";
 *
 * const registry = createRegistry()
 *   .register(myWorkflow);
 * ```
 */
export function createRegistry(): Registry<Record<string, never>> {
  return new RegistryImpl<Record<string, never>>(new Map()) as Registry<Record<string, never>>;
}

// ─── Re-export validators for external use ───────────────────────────────────
export { validateCopilotWorkflow, validateOpenCodeWorkflow, validateClaudeWorkflow };
