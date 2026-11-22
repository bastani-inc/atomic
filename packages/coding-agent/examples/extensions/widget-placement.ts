import type { ExtensionAPI } from "@bastani/atomic";

export default function widgetPlacementExtension(atomic: ExtensionAPI) {
	atomic.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
