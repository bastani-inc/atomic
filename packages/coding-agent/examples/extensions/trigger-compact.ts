import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";

const COMPACT_THRESHOLD_TOKENS = 100_000;

export default function (pi: ExtensionAPI) {
	let previousTokens: number | null | undefined;

	const triggerCompaction = (ctx: ExtensionContext) => {
		if (ctx.hasUI) {
			ctx.ui.notify("Compaction started", "info");
		}
		ctx.compact({
			onComplete: () => {
				if (ctx.hasUI) {
					ctx.ui.notify("Compaction completed", "info");
				}
			},
			onError: (error) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				}
			},
		});
	};

	pi.on("turn_end", (_event, ctx) => {
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

	pi.registerCommand("trigger-compact", {
		description: "Trigger compaction immediately",
		handler: async (args, ctx) => {
			if (args.trim() && ctx.hasUI) {
				ctx.ui.notify("/trigger-compact ignores arguments; Verbatim Compaction uses a fixed deletion planner", "warning");
			}
			triggerCompaction(ctx);
		},
	});
}
