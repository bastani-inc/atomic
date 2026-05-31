/**
 * Workflow definition builder.
 * Authoring API: defineWorkflow(name).description(...).input(...).run(fn).compile()
 *
 * Immutable/chained semantics: every builder method returns a NEW builder
 * instance; the previous instance is unchanged.
 *
 * cross-ref: v0.x packages/atomic-sdk/src/define-workflow.ts
 */

import type {
  WorkflowDefinition,
  WorkflowImportDeclaration,
  WorkflowImportSource,
  WorkflowInputBindings,
  WorkflowInputSchema,
  WorkflowInteractionMetadata,
  WorkflowOutputSchema,
  WorkflowRunFn,
  WorkflowWorktreeInputBinding,
} from "../shared/types.js";
import { normalizeWorkflowName } from "./identity.js";

// ---------------------------------------------------------------------------
// Internal builder state (plain data, never mutated after creation)
// ---------------------------------------------------------------------------

interface BuilderState<TInputs extends Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly inputs: Readonly<Record<string, WorkflowInputSchema>>;
  readonly outputs: Readonly<Record<string, WorkflowOutputSchema>>;
  readonly imports: Readonly<Record<string, WorkflowImportDeclaration>>;
  readonly inputBindings: WorkflowInputBindings;
  readonly interaction: WorkflowInteractionMetadata;
  readonly runFn: WorkflowRunFn<TInputs> | undefined;
}

// ---------------------------------------------------------------------------
// Public builder interfaces — split so .compile() only appears after .run()
// ---------------------------------------------------------------------------

/**
 * Builder returned by defineWorkflow(name) before .run() is called.
 * Allows chaining .description() and .input() in any order; .run() seals
 * the run function and returns a CompletedWorkflowBuilder.
 *
 * TInputs defaults to Record<string, unknown> so that compile() produces a
 * definition compatible with the type-erased registry without casts.
 */
export interface WorkflowBuilder<TInputs extends Record<string, unknown> = Record<string, unknown>> {
  /** Set (or replace) the human-readable description. Returns a new builder. */
  description(text: string): WorkflowBuilder<TInputs>;
  /**
   * Declare a typed input.  Returns a new builder whose TInputs grows with
   * the new key (typed as the schema's default value type).
   */
  input<K extends string>(
    key: K,
    schema: WorkflowInputSchema,
  ): WorkflowBuilder<TInputs & Record<K, unknown>>;
  /** Declare a workflow import that can be executed with ctx.workflow(alias). */
  import(alias: string, source: WorkflowImportSource, options?: { description?: string }): WorkflowBuilder<TInputs>;
  /** Declare an output contract for parent workflows selecting child outputs. */
  output(key: string, schema?: WorkflowOutputSchema): WorkflowBuilder<TInputs>;
  /** Bind workflow inputs to reusable git worktree runtime defaults. */
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): WorkflowBuilder<TInputs>;
  /** Mark this workflow as requiring human interaction when it runs. */
  humanInTheLoop(reason?: string): WorkflowBuilder<TInputs>;
  /** Seal the run function.  Returns a builder on which .compile() is available. */
  run(fn: WorkflowRunFn<TInputs>): CompletedWorkflowBuilder<TInputs>;
}

/**
 * Builder returned after .run() is called.
 * Still allows chaining .description() and .input(); .compile() is now available.
 */
export interface CompletedWorkflowBuilder<TInputs extends Record<string, unknown>> {
  description(text: string): CompletedWorkflowBuilder<TInputs>;
  input<K extends string>(
    key: K,
    schema: WorkflowInputSchema,
  ): CompletedWorkflowBuilder<TInputs & Record<K, unknown>>;
  import(alias: string, source: WorkflowImportSource, options?: { description?: string }): CompletedWorkflowBuilder<TInputs>;
  output(key: string, schema?: WorkflowOutputSchema): CompletedWorkflowBuilder<TInputs>;
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): CompletedWorkflowBuilder<TInputs>;
  humanInTheLoop(reason?: string): CompletedWorkflowBuilder<TInputs>;
  run(fn: WorkflowRunFn<TInputs>): CompletedWorkflowBuilder<TInputs>;
  /** Freeze and return the completed WorkflowDefinition. */
  compile(): WorkflowDefinition<TInputs>;
}

// ---------------------------------------------------------------------------
// Internal factory — constructs a builder from immutable state
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`defineWorkflow: ${label} must be a non-empty string`);
  }
}

function cloneImportSource(source: WorkflowImportSource): WorkflowImportSource {
  if (source === null || typeof source !== "object") {
    throw new TypeError("defineWorkflow: import source must be an object");
  }
  const record = source as Partial<Record<"workflow" | "path" | "export", unknown>>;
  const hasWorkflow = "workflow" in record;
  const hasPath = "path" in record;
  if (hasWorkflow === hasPath) {
    throw new TypeError("defineWorkflow: import source must be exactly one of { workflow } or { path }");
  }
  if (hasWorkflow) {
    if (typeof record.workflow !== "string") {
      throw new TypeError("defineWorkflow: import source.workflow must be a non-empty string");
    }
    requireNonEmptyString(record.workflow, "import source.workflow");
    return Object.freeze({ workflow: record.workflow });
  }
  if (typeof record.path !== "string") {
    throw new TypeError("defineWorkflow: import source.path must be a non-empty string");
  }
  requireNonEmptyString(record.path, "import source.path");
  if (record.export !== undefined && typeof record.export !== "string") {
    throw new TypeError("defineWorkflow: import source.export must be a string when provided");
  }
  return Object.freeze({
    path: record.path,
    ...(record.export !== undefined ? { export: record.export } : {}),
  });
}

function freezeImports(
  imports: Readonly<Record<string, WorkflowImportDeclaration>>,
): Readonly<Record<string, WorkflowImportDeclaration>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(imports).map(([alias, declaration]) => [
      alias,
      Object.freeze({
        source: cloneImportSource(declaration.source),
        ...(declaration.description !== undefined ? { description: declaration.description } : {}),
      }),
    ]),
  ));
}

function freezeOutputs(
  outputs: Readonly<Record<string, WorkflowOutputSchema>>,
): Readonly<Record<string, WorkflowOutputSchema>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(outputs).map(([key, schema]) => [key, Object.freeze({ ...schema })]),
  ));
}

function makeBuilder<TInputs extends Record<string, unknown>>(
  state: BuilderState<TInputs>,
): WorkflowBuilder<TInputs> & CompletedWorkflowBuilder<TInputs> {
  return {
    description(text: string) {
      return makeBuilder<TInputs>({ ...state, description: text });
    },

    input<K extends string>(key: K, schema: WorkflowInputSchema) {
      return makeBuilder<TInputs & Record<K, unknown>>({
        ...state,
        inputs: { ...state.inputs, [key]: schema },
      } as BuilderState<TInputs & Record<K, unknown>>);
    },

    import(alias: string, source: WorkflowImportSource, options?: { description?: string }) {
      requireNonEmptyString(alias, "import alias");
      const declaration: WorkflowImportDeclaration = {
        source: cloneImportSource(source),
        ...(options?.description !== undefined ? { description: options.description } : {}),
      };
      return makeBuilder<TInputs>({
        ...state,
        imports: { ...state.imports, [alias]: declaration },
      });
    },

    output(key: string, schema: WorkflowOutputSchema = {}) {
      requireNonEmptyString(key, "output key");
      return makeBuilder<TInputs>({
        ...state,
        outputs: { ...state.outputs, [key]: { ...schema } },
      });
    },

    worktreeFromInputs(binding: WorkflowWorktreeInputBinding) {
      return makeBuilder<TInputs>({
        ...state,
        inputBindings: {
          ...state.inputBindings,
          worktree: { ...binding },
        },
      });
    },

    humanInTheLoop(reason?: string) {
      return makeBuilder<TInputs>({
        ...state,
        interaction: Object.freeze({
          humanInput: "required" as const,
          ...(reason !== undefined ? { reason } : {}),
        }),
      });
    },

    run(fn: WorkflowRunFn<TInputs>) {
      return makeBuilder<TInputs>({ ...state, runFn: fn });
    },

    compile(): WorkflowDefinition<TInputs> {
      if (!state.runFn) {
        throw new Error(
          `defineWorkflow("${state.name}"): .run(fn) must be called before .compile()`,
        );
      }

      const normalizedName = normalizeWorkflowName(state.name);

      // Deep-freeze nested maps first, then the top-level definition.
      const frozenInputs = Object.freeze({ ...state.inputs });
      const frozenOutputs = freezeOutputs(state.outputs);
      const frozenImports = freezeImports(state.imports);
      const inputBindings = Object.freeze({
        ...state.inputBindings,
        ...(state.inputBindings.worktree !== undefined
          ? { worktree: Object.freeze({ ...state.inputBindings.worktree }) }
          : {}),
      });
      const interaction = Object.freeze({ ...state.interaction });

      const definition: WorkflowDefinition<TInputs> = {
        __piWorkflow: true,
        name: state.name,
        normalizedName,
        description: state.description,
        inputs: frozenInputs,
        ...(Object.keys(frozenOutputs).length > 0 ? { outputs: frozenOutputs } : {}),
        ...(Object.keys(frozenImports).length > 0 ? { imports: frozenImports } : {}),
        ...(Object.keys(inputBindings).length > 0 ? { inputBindings } : {}),
        interaction,
        run: state.runFn,
      };

      return Object.freeze(definition) as WorkflowDefinition<TInputs>;
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Start building a workflow definition.
 *
 * @example
 * import { defineWorkflow } from "@bastani/workflows";
 *
 * export default defineWorkflow("deep-research-codebase")
 *   .description("Scout → specialists → aggregator")
 *   .input("prompt", { type: "text", required: true, description: "research question" })
 *   .input("max_partitions", { type: "number", default: 4 })
 *   .run(async (ctx) => {
 *     const scout = ctx.stage("scout");
 *     const findings = await scout.prompt(`Scout: ${ctx.inputs.prompt}`);
 *     return { findings };
 *   })
 *   .compile();
 */
export function defineWorkflow(name: string): WorkflowBuilder {
  if (!name || typeof name !== "string") {
    throw new TypeError("defineWorkflow: name must be a non-empty string");
  }

  const initialState: BuilderState<Record<string, unknown>> = {
    name,
    description: "",
    inputs: {},
    outputs: {},
    imports: {},
    inputBindings: {},
    interaction: Object.freeze({ humanInput: "none" }),
    runFn: undefined,
  };

  return makeBuilder(initialState);
}
