import type { PackageManagerContext, ProgressEvent } from "./package-manager-types.ts";

export function emitProgress(context: PackageManagerContext, event: ProgressEvent): void {
	context.progressCallback?.(event);
}

export async function withProgress(
	context: PackageManagerContext,
	action: ProgressEvent["action"],
	source: string,
	message: string,
	operation: () => Promise<void>,
): Promise<void> {
	emitProgress(context, { type: "start", action, source, message });
	try {
		await operation();
		emitProgress(context, { type: "complete", action, source });
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		emitProgress(context, { type: "error", action, source, message: errorMessage });
		throw error;
	}
}
