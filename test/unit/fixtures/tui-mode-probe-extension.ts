import type { ExtensionAPI } from "../../../packages/coding-agent/src/index.ts";

/** `/probe-tui-mode` opens a `ctx.ui.custom()` component that paints the mode of the TUI the extension was given. */
export default function tuiModeProbeFixture(api: ExtensionAPI): void {
	api.registerCommand("probe-tui-mode", {
		description: "Paint the TUI mode an extension component sees",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>((tui) => ({
				render: () => [`probe tui.mode=${tui.mode}`],
				invalidate: () => {},
			}));
		},
	});
}
