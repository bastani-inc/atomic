import { type DurableUiDeps, wrapUiWithDurable } from "../../durable/ui-primitive.js";
import { makeHeadlessUnavailableUIContext, normalizeUIContext } from "../../runs/foreground/executor-hil.js";
import type { RunOpts } from "../../runs/foreground/executor-types.js";
import type { WorkflowUIContext as AuthoringWorkflowUIContext } from "../../shared/authoring-contract-ui.js";
import { withPromptCallerStack } from "../../shared/prompt-callsite-context.js";
import type { WorkflowCustomUiFactory, WorkflowCustomUiOptions, WorkflowUIContext } from "../../shared/types.js";

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
	const base =
		input.opts.usePromptNodesForUi === true
			? input.baseFromPromptNodes()
			: input.opts.executionMode === "non_interactive" && input.opts.ui === undefined
				? makeHeadlessUnavailableUIContext()
				: normalizeUIContext(input.opts.ui);
	// Prompt-node continuation owns replay so its stage remains observable;
	// durable response replay is for non-node UI and fresh redispatches.
	const promptNodeReplay = input.opts.usePromptNodesForUi === true && input.opts.continuation !== undefined;
	const durableBase =
		input.durableUi !== undefined && !promptNodeReplay ? wrapUiWithDurable(base, input.durableUi) : base;
	const invoke = <T>(call: () => Promise<T>): Promise<T> => {
		input.throwIfWorkflowExitSelected();
		if (!promptNodeReplay || input.durableUi?.beforeCall === undefined) return call();
		// This path bypasses the durable UI wrapper. Preserve its author callsite
		// while waiting, just as that wrapper does before cached/live admission.
		return withPromptCallerStack(new Error().stack, async () => {
			for (let wait = input.durableUi?.beforeCall?.(); wait !== undefined; wait = input.durableUi?.beforeCall?.())
				await wait;
			input.throwIfWorkflowExitSelected();
			return call();
		});
	};
	return {
		async input(promptText: string): Promise<string> {
			return await invoke(() => durableBase.input(promptText));
		},
		async confirm(message: string): Promise<boolean> {
			return await invoke(() => durableBase.confirm(message));
		},
		async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
			return await invoke(() => durableBase.select(message, options));
		},
		async editor(initial?: string): Promise<string> {
			return await invoke(() => durableBase.editor(initial));
		},
		async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
			return await invoke(() => durableBase.custom(factory, options));
		},
	};
}
