/**
 * Workflow definition builder.
 * Authoring API: defineWorkflow(name).description(...).input(...).run(fn).compile()
 *
 * Immutable/chained semantics: every builder method returns a NEW builder
 * instance; the previous instance is unchanged.
 *
 * cross-ref: v0.x packages/atomic-sdk/src/define-workflow.ts
 */

import type { Static, TOptional, TSchema } from "typebox";
import type {
  WorkflowDefinition,
  WorkflowInputBindings,
  WorkflowInputValues,
  WorkflowOutputValues,
  WorkflowRunFn,
  WorkflowWorktreeInputBinding,
} from "../shared/types.js";
import { normalizeWorkflowName } from "./identity.js";

// ---------------------------------------------------------------------------
// Type inference helpers (TypeBox Static<> mapping)
// ---------------------------------------------------------------------------

/**
 * One declared key as a single-key object type. An `Type.Optional(...)` schema
 * makes the KEY optional (so access yields `T | undefined`); every other schema
 * — including a defaulted one — makes the key required (defaults are always
 * present at runtime after they are applied). A schema `default` is not
 * detectable at the type level, which is the correct behavior here.
 */
type DeclaredEntry<K extends string, S extends TSchema> =
  S extends TOptional<TSchema>
    ? { readonly [P in K]?: Static<S> }
    : { readonly [P in K]: Static<S> };

/** Collapse an accumulated intersection into a single, readable object type. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

type SimplifyWorkflowOutputs<T> = Simplify<T>;

interface BuilderState<TInputs extends WorkflowInputValues> {
  readonly name: string;
  readonly description: string;
  readonly inputs: Readonly<Record<string, TSchema>>;
  readonly outputs: Readonly<Record<string, TSchema>>;
  readonly inputBindings: WorkflowInputBindings;
  // Stored type-erased on outputs: the builder threads the precise output map
  // through its public interface, but the immutable state survives across
  // generic changes, so it keeps the loose run-fn type and re-applies the
  // precise type at .run()/.compile() boundaries via casts.
  readonly runFn: WorkflowRunFn<TInputs, WorkflowOutputValues> | undefined;
}

// ---------------------------------------------------------------------------
// Public builder interfaces — split so .compile() only appears after .run()
// ---------------------------------------------------------------------------

/**
 * Builder returned by defineWorkflow(name) before .run() is called.
 * Allows chaining .description() and .input() in any order; .run() seals
 * the run function and returns a CompletedWorkflowBuilder.
 *
 * TInputs defaults to serializable input values so compiled definitions stay
 * compatible with the type-erased registry without casts.
 */
export interface WorkflowBuilder<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = {},
> {
  /** Set (or replace) the human-readable description. Returns a new builder. */
  description(text: string): WorkflowBuilder<TInputs, TOutputs>;
  /**
   * Declare a typed input.  Returns a new builder whose TInputs grows with
   * the new key (typed as the schema's default value type).
   */
  input<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): WorkflowBuilder<TInputs & DeclaredEntry<K, S>, TOutputs>;
  /**
   * Declare a typed output.  Returns a new builder whose TOutputs grows with
   * the new key (optional when the schema is `Type.Optional(...)`, otherwise
   * required), so the `.run()` return is statically checked against the
   * declared contract.
   */
  output<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): WorkflowBuilder<TInputs, TOutputs & DeclaredEntry<K, S>>;
  /** Bind workflow inputs to reusable git worktree runtime defaults. */
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): WorkflowBuilder<TInputs, TOutputs>;
  /** Seal the run function.  Returns a builder on which .compile() is available. */
  run(
    fn: WorkflowRunFn<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>,
  ): CompletedWorkflowBuilder<TInputs, TOutputs>;
}

/**
 * Builder returned after .run() is called.
 * Still allows chaining .description() and .input(); .compile() is now available.
 */
export interface CompletedWorkflowBuilder<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
> {
  description(text: string): CompletedWorkflowBuilder<TInputs, TOutputs>;
  input<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): CompletedWorkflowBuilder<TInputs & DeclaredEntry<K, S>, TOutputs>;
  output<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): CompletedWorkflowBuilder<TInputs, TOutputs & DeclaredEntry<K, S>>;
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): CompletedWorkflowBuilder<TInputs, TOutputs>;
  run(
    fn: WorkflowRunFn<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>,
  ): CompletedWorkflowBuilder<TInputs, TOutputs>;
  /** Freeze and return the completed WorkflowDefinition. */
  compile(): WorkflowDefinition<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>;
}

// ---------------------------------------------------------------------------
// Internal factory — constructs a builder from immutable state
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`defineWorkflow: ${label} must be a non-empty string`);
  }
}

// Freeze only the top-level map. The per-key TypeBox schemas are shared,
// internally-symbol-keyed objects and must not be shallow-cloned (that would
// drop the Kind/Optional symbols the runtime validator relies on).
function freezeSchemaMap(
  schemas: Readonly<Record<string, TSchema>>,
): Readonly<Record<string, TSchema>> {
  return Object.freeze({ ...schemas });
}

function makeBuilder<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
>(
  state: BuilderState<TInputs>,
): WorkflowBuilder<TInputs, TOutputs> & CompletedWorkflowBuilder<TInputs, TOutputs> {
  return {
    description(text: string) {
      return makeBuilder<TInputs, TOutputs>({ ...state, description: text });
    },

    input<K extends string, S extends TSchema>(key: K, schema: S) {
      requireNonEmptyString(key, "input key");
      return makeBuilder<TInputs & DeclaredEntry<K, S>, TOutputs>({
        ...state,
        inputs: { ...state.inputs, [key]: schema },
      } as BuilderState<TInputs & DeclaredEntry<K, S>>);
    },

    output<K extends string, S extends TSchema>(key: K, schema: S) {
      requireNonEmptyString(key, "output key");
      return makeBuilder<TInputs, TOutputs & DeclaredEntry<K, S>>({
        ...state,
        outputs: { ...state.outputs, [key]: schema },
      });
    },

    worktreeFromInputs(binding: WorkflowWorktreeInputBinding) {
      return makeBuilder<TInputs, TOutputs>({
        ...state,
        inputBindings: {
          ...state.inputBindings,
          worktree: { ...binding },
        },
      });
    },

    run(fn: WorkflowRunFn<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>) {
      return makeBuilder<TInputs, TOutputs>({
        ...state,
        runFn: fn as unknown as WorkflowRunFn<TInputs, WorkflowOutputValues>,
      });
    },

    compile(): WorkflowDefinition<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>> {
      if (!state.runFn) {
        throw new Error(
          `defineWorkflow("${state.name}"): .run(fn) must be called before .compile()`,
        );
      }

      const normalizedName = normalizeWorkflowName(state.name);

      // Deep-freeze nested maps first, then the top-level definition.
      const frozenInputs = freezeSchemaMap(state.inputs);
      const frozenOutputs = freezeSchemaMap(state.outputs);
      const inputBindings = Object.freeze({
        ...state.inputBindings,
        ...(state.inputBindings.worktree !== undefined
          ? { worktree: Object.freeze({ ...state.inputBindings.worktree }) }
          : {}),
      });

      const definition: WorkflowDefinition<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>> = {
        __piWorkflow: true,
        name: state.name,
        normalizedName,
        description: state.description,
        inputs: frozenInputs,
        ...(Object.keys(frozenOutputs).length > 0 ? { outputs: frozenOutputs } : {}),
        ...(Object.keys(inputBindings).length > 0 ? { inputBindings } : {}),
        run: state.runFn as unknown as WorkflowRunFn<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>,
      };

      return Object.freeze(definition) as WorkflowDefinition<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>;
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
 * import { defineWorkflow, Type } from "@bastani/workflows";
 *
 * export default defineWorkflow("deep-research-codebase")
 *   .description("Scout → specialists → aggregator")
 *   .input("prompt", Type.String({ description: "research question" }))
 *   .input("max_partitions", Type.Number({ default: 4 }))
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

  const initialState: BuilderState<WorkflowInputValues> = {
    name,
    description: "",
    inputs: {},
    outputs: {},
    inputBindings: {},
    runFn: undefined,
  };

  // Start with an empty output map so excess-property checks engage as soon as
  // the first `.output(...)` is declared; a workflow with no declared outputs
  // must return `{}` (the executor rejects any undeclared key).
  return makeBuilder<WorkflowInputValues, {}>(initialState);
}
