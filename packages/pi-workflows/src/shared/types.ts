/**
 * Cross-cutting shared types for pi-workflows.
 * cross-ref: pi-subagents src/shared/types.ts
 */

// ---------------------------------------------------------------------------
// Workflow input schema
// ---------------------------------------------------------------------------

/** Discriminated union of supported input kinds. */
export type WorkflowInputType = "text" | "string" | "number" | "boolean" | "select";

interface BaseInputSchema {
  description?: string;
  required?: boolean;
}

export interface TextInputSchema extends BaseInputSchema {
  type: "text" | "string";
  default?: string;
}

export interface NumberInputSchema extends BaseInputSchema {
  type: "number";
  default?: number;
}

export interface BooleanInputSchema extends BaseInputSchema {
  type: "boolean";
  default?: boolean;
}

export interface SelectInputSchema extends BaseInputSchema {
  type: "select";
  /** Non-empty array of valid string choices. */
  choices: readonly string[];
  default?: string;
}

/** Union of all concrete input schema shapes. */
export type WorkflowInputSchema =
  | TextInputSchema
  | NumberInputSchema
  | BooleanInputSchema
  | SelectInputSchema;

// ---------------------------------------------------------------------------
// HIL (human-in-the-loop) primitives available inside run functions
// ---------------------------------------------------------------------------

/**
 * HIL surface available on WorkflowRunContext.ui.
 * Each primitive suspends the current stage until the user responds.
 * Mirrors pi's ctx.ui.input / confirm / select / editor methods.
 */
export interface WorkflowUIContext {
  /** Ask the user for a free-text value. */
  input(prompt: string): Promise<string>;
  /** Ask the user a yes/no question. */
  confirm(message: string): Promise<boolean>;
  /** Ask the user to pick from a fixed list of options. */
  select<T extends string>(message: string, options: readonly T[]): Promise<T>;
  /** Open a text editor; resolves with the user's final content. */
  editor(initial?: string): Promise<string>;
}

/**
 * Adapter supplied by the pi runtime (or test harness) to back the HIL
 * primitives.  Must implement the same surface as WorkflowUIContext so that
 * the executor can delegate directly.
 */
export type WorkflowUIAdapter = WorkflowUIContext;

// ---------------------------------------------------------------------------
// Stage context (provided to ctx.stage() calls)
// ---------------------------------------------------------------------------

/** Options for delegating a stage to a pi-subagents sub-agent. */
export interface SubagentStageOpts {
  /** Name of the registered sub-agent to invoke. */
  agent: string;
  /** Task description forwarded to the sub-agent. */
  task: string;
  /** Optional additional context to inject. */
  context?: string;
}

/** Options for a one-shot completion (no session, no tool use). */
export interface CompleteStageOpts {
  /** Override the model for this completion. */
  model?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
}

export interface StageContext {
  /** Human-readable name for this stage (used in TUI + persistence). */
  readonly name: string;
  /**
   * Spawn a new pi session and send the prompt; awaits the full assistant
   * response.  This is the default stage execution mode.
   */
  prompt(text: string): Promise<string>;
  /**
   * Delegate this stage to a pi-subagents sub-agent.
   * Requires pi-subagents to be installed; throws a clear error if absent.
   */
  subagent(opts: SubagentStageOpts): Promise<string>;
  /**
   * Perform a one-shot LLM completion (no session, no tool use).
   * Useful for cheap classification/summarisation stages.
   */
  complete(text: string, opts?: CompleteStageOpts): Promise<string>;
}

// ---------------------------------------------------------------------------
// Workflow run context (top-level ctx passed to the run function)
// ---------------------------------------------------------------------------

export interface WorkflowRunContext<TInputs extends Record<string, unknown> = Record<string, unknown>> {
  /** Typed inputs provided by the caller, validated against the input schema. */
  readonly inputs: TInputs;
  /**
   * Create and register a named stage.  Stages can be sequenced (await) or
   * parallelised (Promise.all); the executor infers the DAG automatically.
   */
  stage(name: string): StageContext;
  /** HIL primitives for user interaction during a run. */
  readonly ui: WorkflowUIContext;
}

// ---------------------------------------------------------------------------
// Workflow run function
// ---------------------------------------------------------------------------

export type WorkflowRunFn<TInputs extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: WorkflowRunContext<TInputs>,
) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Compiled workflow definition
// ---------------------------------------------------------------------------

export interface WorkflowDefinition<TInputs extends Record<string, unknown> = Record<string, unknown>> {
  /** Sentinel consumed by the registry loader to validate the export. */
  readonly __piWorkflow: true;
  readonly name: string;
  /** Normalised name (lowercase, hyphens) used as the registry key. */
  readonly normalizedName: string;
  readonly description: string;
  readonly inputs: Readonly<Record<string, WorkflowInputSchema>>;
  readonly run: WorkflowRunFn<TInputs>;
}
