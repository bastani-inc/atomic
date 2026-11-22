import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";

const COMPACT_THRESHOLD_TOKENS = 100_000;

export default function (atomic: ExtensionAPI) {
	let previousTokens: number | null | undefined;

	const triggerCompaction = (ctx: ExtensionContext, instructions?: string) => {
		if (ctx.hasUI) {
			ctx.ui.notify("Compaction started", "info");
		}
		ctx.compact({
			// Instructions tell the agent what to recover first after the context is cleared.
			...(instructions ? { query: instructions } : {}),
			onComplete: (result) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`Context ${result.form}`, "info");
				}
			},
			onError: (error) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				}
			},
		});
	};

	atomic.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const currentTokens = usage?.tokens ?? null;
		if (currentTokens === null) {
			return;
		}

		const crossedThreshold =
			previousTokens !== undefined && previousTokens !== null && previousTokens <= COMPACT_THRESHOLD_TOKENS;
		previousTokens = currentTokens;
		if (!crossedThreshold || currentTokens <= COMPACT_THRESHOLD_TOKENS) {
			return;
		}
		triggerCompaction(ctx);
	});

	atomic.registerCommand("trigger-compact", {
		description: "Trigger compaction immediately; optional instructions say what to recover first",
		handler: async (args, ctx) => {
			triggerCompaction(ctx, args.trim() || undefined);
		},
	});
}
