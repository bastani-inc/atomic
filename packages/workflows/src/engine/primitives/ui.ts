import type {
  WorkflowCustomUiFactory,
  WorkflowCustomUiOptions,
  WorkflowUIContext,
} from "../../shared/types.js";
import type { RunOpts } from "../../runs/foreground/executor-types.js";
import { makeHeadlessUnavailableUIContext, normalizeUIContext } from "../../runs/foreground/executor-hil.js";

export function buildExitGatedUiContext(input: {
  readonly opts: RunOpts;
  readonly baseFromPromptNodes: () => WorkflowUIContext;
  readonly throwIfWorkflowExitSelected: () => void;
}): WorkflowUIContext {
  const base = input.opts.usePromptNodesForUi === true
    ? input.baseFromPromptNodes()
    : input.opts.executionMode === "non_interactive" && input.opts.ui === undefined
      ? makeHeadlessUnavailableUIContext()
      : normalizeUIContext(input.opts.ui);
  return {
    async input(promptText: string): Promise<string> {
      input.throwIfWorkflowExitSelected();
      return await base.input(promptText);
    },
    async confirm(message: string): Promise<boolean> {
      input.throwIfWorkflowExitSelected();
      return await base.confirm(message);
    },
    async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      input.throwIfWorkflowExitSelected();
      return await base.select(message, options);
    },
    async editor(initial?: string): Promise<string> {
      input.throwIfWorkflowExitSelected();
      return await base.editor(initial);
    },
    async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
      input.throwIfWorkflowExitSelected();
      return await base.custom(factory, options);
    },
  };
}
