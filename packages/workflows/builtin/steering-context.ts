/**
 * Steering propagation wrapper for builtin workflow run contexts.
 *
 * Every builtin workflow wraps its run context once, at the definition entry
 * point, so each `ctx.task` / `ctx.chain` / `ctx.parallel` prompt carries the
 * steering propagation contract. Wrapping the context rather than every call
 * site means a stage added later inherits the pattern instead of silently
 * dropping user amendments on the floor.
 *
 * The wrapper delegates through the prototype chain rather than spreading:
 * the runtime context exposes `cwd` as a getter that resolves the workflow's
 * current working directory on each read, and a spread would snapshot it.
 *
 * cross-ref:
 *   - builtin/shared-prompts.ts (STEERING_PROPAGATION_CONTRACT)
 *   - test/unit/builtin-workflow-steering-propagation.test.ts (enforcement)
 */
import type {
  WorkflowInputValues,
  WorkflowOutputValues,
  WorkflowRunContext,
  WorkflowTaskOptions,
  WorkflowTaskStep,
} from "../src/shared/types.js";
import { withSteeringPropagation } from "./shared-prompts.js";

function withPromptContract(options: WorkflowTaskOptions): WorkflowTaskOptions {
  return options.prompt === undefined
    ? options
    : { ...options, prompt: withSteeringPropagation(options.prompt) };
}

function withStepContract(step: WorkflowTaskStep): WorkflowTaskStep {
  const withPrompt = step.prompt === undefined
    ? step
    : { ...step, prompt: withSteeringPropagation(step.prompt) };
  return withPrompt.task === undefined
    ? withPrompt
    : { ...withPrompt, task: withSteeringPropagation(withPrompt.task) };
}

export function withSteeringPropagationContext<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
>(ctx: WorkflowRunContext<TInputs, TOutputs>): WorkflowRunContext<TInputs, TOutputs> {
  const wrapped = Object.create(ctx) as WorkflowRunContext<TInputs, TOutputs>;
  wrapped.task = (name, options) => ctx.task(name, withPromptContract(options));
  wrapped.chain = (steps, options) => ctx.chain(steps.map(withStepContract), options);
  wrapped.parallel = (steps, options) => ctx.parallel(steps.map(withStepContract), options);
  return wrapped;
}
