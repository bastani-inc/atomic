import { snapshotEventHandlers } from "./runner-events.ts";
import type {
	ExtensionError,
	ExtensionUIDialogOptions,
	LoadExtensionsResult,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
} from "./types.ts";

function withHandlerSignal(opts: ExtensionUIDialogOptions | undefined, signal: AbortSignal): ExtensionUIDialogOptions {
	return {
		...opts,
		signal: opts?.signal ? AbortSignal.any([opts.signal, signal]) : signal,
	};
}

function guardUnhandled<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => {});
	return promise;
}

function scopeProjectTrustContext(ctx: ProjectTrustContext, signal: AbortSignal): ProjectTrustContext {
	return {
		...ctx,
		ui: {
			...ctx.ui,
			select: (title, options, opts) =>
				guardUnhandled(ctx.ui.select(title, options, withHandlerSignal(opts, signal))),
			confirm: (title, message, opts) =>
				guardUnhandled(ctx.ui.confirm(title, message, withHandlerSignal(opts, signal))),
			input: (title, placeholder, opts) =>
				guardUnhandled(ctx.ui.input(title, placeholder, withHandlerSignal(opts, signal))),
		},
	};
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
	onSnapshot?: (hasHandlers: boolean) => void,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	const voters = snapshotEventHandlers(extensionsResult.extensions, "project_trust");
	onSnapshot?.(voters.some(({ handlers }) => handlers.length > 0));
	for (const { ext, handlers } of voters) {
		for (const handler of handlers) {
			const abort = new AbortController();
			try {
				const handlerResult = (await handler(
					event,
					scopeProjectTrustContext(ctx, abort.signal),
				)) as ProjectTrustEventResult;
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
			} finally {
				abort.abort();
			}
		}
	}
	return { errors };
}
