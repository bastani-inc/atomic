import type {
	ExtensionError,
	LoadExtensionsResult,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
} from "./types.ts";
import { openUserBlock } from "./user-blocks.js";

/** The restricted prompt methods a `project_trust` handler can open. */
const TRUST_PROMPT_METHODS = ["select", "confirm", "input"] as const;

type TrustPromptMethod = (typeof TRUST_PROMPT_METHODS)[number];

type TrustUi = ProjectTrustContext["ui"];

type TrustPromptFunction<M extends TrustPromptMethod> = TrustUi[M];

type TrustPromptArgs<M extends TrustPromptMethod> = Parameters<TrustPromptFunction<M>>;

type TrustPromptResult<M extends TrustPromptMethod> = ReturnType<TrustPromptFunction<M>>;

function settlesLater(value: TrustPromptResult<TrustPromptMethod>): boolean {
	if (value === null) return false;
	if (typeof value !== "object" && typeof value !== "function") return false;
	return typeof Reflect.get(value, "then") === "function";
}

/**
 * Wrap one restricted prompt so it reports the agent as waiting on a person.
 *
 * The host method runs on the host's own UI object, and the block is released
 * on a synchronous throw, a rejection, and normal settlement alike — the same
 * shape as the `ctx.ui` wrapper, and for the same reason.
 */
function wrapTrustPrompt<M extends TrustPromptMethod>(
	method: M,
	ui: TrustUi,
	original: TrustPromptFunction<M>,
): TrustPromptFunction<M> {
	const wrapped = (...args: TrustPromptArgs<M>): TrustPromptResult<M> => {
		const title = args[0];
		const block = openUserBlock(typeof title === "string" ? title : method, "project_trust");

		let result: TrustPromptResult<M>;
		try {
			result = Reflect.apply(original, ui, args) as TrustPromptResult<M>;
		} catch (error) {
			block.release();
			throw error;
		}

		let pending: boolean;
		try {
			pending = settlesLater(result);
		} catch (error) {
			block.release();
			throw error;
		}
		if (!pending) {
			block.release();
			return result;
		}
		return Promise.resolve(result).finally(() => block.release()) as TrustPromptResult<M>;
	};
	return wrapped as TrustPromptFunction<M>;
}

/**
 * A trust context whose prompts mint a `project_trust` block.
 *
 * An extension's `project_trust` handler receives the same restricted UI the
 * host built, and a prompt it opens stops the agent exactly like the built-in
 * one does — so it has to be reported the same way. `notify` is left alone; it
 * does not wait for anyone.
 *
 * Only the handler path is wrapped. `selectProjectTrustOption()` opens its own
 * block for the fallback prompt, and wrapping both would count one wait twice.
 *
 * The public `ProjectTrustContext` shape is unchanged: this is a derived object
 * with the same members.
 */
function withTrustPromptBlocks(ctx: ProjectTrustContext): ProjectTrustContext {
	const ui = ctx.ui;
	const wrappedUi: TrustUi = {
		...ui,
		select: wrapTrustPrompt("select", ui, ui.select),
		confirm: wrapTrustPrompt("confirm", ui, ui.confirm),
		input: wrapTrustPrompt("input", ui, ui.input),
	};
	return { ...ctx, ui: wrappedUi };
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	const handlerCtx = withTrustPromptBlocks(ctx);
	for (const ext of extensionsResult.extensions) {
		const handlers = ext.handlers.get("project_trust");
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, handlerCtx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionPath: ext.path,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}
