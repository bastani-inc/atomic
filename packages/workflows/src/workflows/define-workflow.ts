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
import type * as AuthoringContract from "../shared/authoring-contract.js";
import type {
  WorkflowDefinition,
  WorkflowInputBindings,
  WorkflowInputValues,
  WorkflowOutputValues,
  WorkflowRunContext,
  WorkflowSerializableValue,
  WorkflowRunFn,
  WorkflowWorktreeInputBinding,
} from "../shared/types.js";
import { normalizeWorkflowName } from "./identity.js";

const BRANDED_WORKFLOW_DEFINITIONS = new WeakSet<object>();

// Package-internal runtime brand. It deliberately is not exported through the
// public SDK surface; only defineWorkflow(...).compile() and executor-created
// direct workflows can mint discoverable definitions.
export function stampWorkflowDefinition<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
>(
  definition: WorkflowDefinition<TInputs, TOutputs>,
): WorkflowDefinition<TInputs, TOutputs> {
  BRANDED_WORKFLOW_DEFINITIONS.add(definition);
  return definition;
}

export function isBrandedWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return value !== null &&
    typeof value === "object" &&
    BRANDED_WORKFLOW_DEFINITIONS.has(value);
}

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
type DeclaredOutputEntry<K extends string, S extends TSchema> =
  S extends TOptional<TSchema>
    ? { readonly [P in K]?: Static<S> & WorkflowSerializableValue }
    : { readonly [P in K]: Static<S> & WorkflowSerializableValue };

type AccumulateWorkflowOutput<TOutputs, K extends string, S extends TSchema> = Simplify<
  string extends keyof TOutputs
    ? DeclaredOutputEntry<K, S>
    : TOutputs & DeclaredOutputEntry<K, S>
>;

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
  TInputs extends WorkflowInputValues = {},
  TOutputs extends WorkflowOutputValues = {},
> extends Omit<
  AuthoringContract.WorkflowBuilder<TInputs, TOutputs>,
  "description" | "input" | "output" | "worktreeFromInputs" | "run"
> {
  description(text: string): WorkflowBuilder<TInputs, TOutputs>;
  input<K extends string, S extends TSchema>(key: K, schema: S): WorkflowBuilder<TInputs & DeclaredEntry<K, S>, TOutputs>;
  output<K extends string, S extends TSchema>(key: K, schema: S): WorkflowBuilder<TInputs, AccumulateWorkflowOutput<TOutputs, K, S>>;
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): WorkflowBuilder<TInputs, TOutputs>;
  run<TActualOutputs extends SimplifyWorkflowOutputs<TOutputs>>(
    fn: (ctx: WorkflowRunContext<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>) => Promise<AuthoringContract.NoExtraOutputs<SimplifyWorkflowOutputs<TOutputs>, TActualOutputs>> | AuthoringContract.NoExtraOutputs<SimplifyWorkflowOutputs<TOutputs>, TActualOutputs>,
  ): CompletedWorkflowBuilder<TInputs, TOutputs>;
}

/**
 * Builder returned after .run() is called.
 * Still allows chaining .description() and .input(); .compile() is now available.
 */
export interface CompletedWorkflowBuilder<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
> extends Omit<
  AuthoringContract.CompletedWorkflowBuilder<TInputs, TOutputs>,
  "description" | "input" | "output" | "worktreeFromInputs" | "run" | "compile"
> {
  description(text: string): CompletedWorkflowBuilder<TInputs, TOutputs>;
  input<K extends string, S extends TSchema>(key: K, schema: S): CompletedWorkflowBuilder<TInputs & DeclaredEntry<K, S>, TOutputs>;
  output<K extends string, S extends TSchema>(key: K, schema: S): CompletedWorkflowBuilder<TInputs, AccumulateWorkflowOutput<TOutputs, K, S>>;
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): CompletedWorkflowBuilder<TInputs, TOutputs>;
  run<TActualOutputs extends SimplifyWorkflowOutputs<TOutputs>>(
    fn: (ctx: WorkflowRunContext<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>) => Promise<AuthoringContract.NoExtraOutputs<SimplifyWorkflowOutputs<TOutputs>, TActualOutputs>> | AuthoringContract.NoExtraOutputs<SimplifyWorkflowOutputs<TOutputs>, TActualOutputs>,
  ): CompletedWorkflowBuilder<TInputs, TOutputs>;
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
      return makeBuilder<TInputs, AccumulateWorkflowOutput<TOutputs, K, S>>({
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

    run<TActualOutputs extends SimplifyWorkflowOutputs<TOutputs>>(
      fn: (ctx: WorkflowRunContext<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>) => Promise<AuthoringContract.NoExtraOutputs<SimplifyWorkflowOutputs<TOutputs>, TActualOutputs>> | AuthoringContract.NoExtraOutputs<SimplifyWorkflowOutputs<TOutputs>, TActualOutputs>,
    ) {
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

      const definition = {
        __piWorkflow: true,
        name: state.name,
        normalizedName,
        description: state.description,
        inputs: frozenInputs,
        ...(Object.keys(frozenOutputs).length > 0 ? { outputs: frozenOutputs } : {}),
        ...(Object.keys(inputBindings).length > 0 ? { inputBindings } : {}),
        run: state.runFn as unknown as WorkflowRunFn<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>,
      } as WorkflowDefinition<Simplify<TInputs>, SimplifyWorkflowOutputs<TOutputs>>;

      // Stamp before freezing so the WeakSet brand can be attached.
      stampWorkflowDefinition(definition);
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

  const initialState: BuilderState<{}> = {
    name,
    description: "",
    inputs: {},
    outputs: {},
    inputBindings: {},
    runFn: undefined,
  };

  return makeBuilder<{}, {}>(initialState);
}
