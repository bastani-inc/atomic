import type {
  WorkflowCustomUiFactory,
  WorkflowCustomUiOptions,
  WorkflowUIContext,
} from "../../shared/types.js";
import type { RunOpts } from "../../runs/foreground/executor-types.js";
import { makeHeadlessUnavailableUIContext, normalizeUIContext } from "../../runs/foreground/executor-hil.js";
import type { WorkflowUIContext as AuthoringWorkflowUIContext } from "../../shared/authoring-contract-ui.js";
import { wrapUiWithDurable, type DurableUiDeps } from "../../durable/ui-primitive.js";

export interface BuildExitGatedUiContextInput {
  readonly opts: RunOpts;
  readonly baseFromPromptNodes: () => AuthoringWorkflowUIContext;
  readonly throwIfWorkflowExitSelected: () => void;
  /**
   * Optional durable UI deps. When provided, completed ctx.ui responses are
   * cached durably and replayed on resume instead of re-asking the user.
   *
   * cross-ref: issue #1498 — durable ctx.ui response/pending prompt state.
   */
  readonly durableUi?: DurableUiDeps;
}

export function buildExitGatedUiContext(input: BuildExitGatedUiContextInput): WorkflowUIContext {
  const base = input.opts.usePromptNodesForUi === true
    ? input.baseFromPromptNodes()
    : input.opts.executionMode === "non_interactive" && input.opts.ui === undefined
      ? makeHeadlessUnavailableUIContext()
      : normalizeUIContext(input.opts.ui);
  // Wrap the resolved base UI with durable caching when deps are supplied.
  // The durable wrapper is transparent when no cached response exists.
  const durableBase = input.durableUi !== undefined ? wrapUiWithDurable(base, input.durableUi) : base;
  return {
    async input(promptText: string): Promise<string> {
      input.throwIfWorkflowExitSelected();
      return await durableBase.input(promptText);
    },
    async confirm(message: string): Promise<boolean> {
      input.throwIfWorkflowExitSelected();
      return await durableBase.confirm(message);
    },
    async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      input.throwIfWorkflowExitSelected();
      return await durableBase.select(message, options);
    },
    async editor(initial?: string): Promise<string> {
      input.throwIfWorkflowExitSelected();
      return await durableBase.editor(initial);
    },
    async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
      input.throwIfWorkflowExitSelected();
      return await durableBase.custom(factory, options);
    },
  };
}
