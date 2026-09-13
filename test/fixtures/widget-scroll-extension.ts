import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/index.js";

/** Dedicated terminal fixture: no model calls, workflow execution, or persistent state. */
export default function widgetScrollFixture(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget("scroll-fixture", () => ({
			render: (width) => Array.from({ length: 30 }, (_, index) => truncateToWidth(`SCROLL ROW ${index}`, width)),
			invalidate() {},
		}), { placement: "belowEditor", scroll: { maxHeight: 5 } });
		ctx.ui.setEditorText("typing stays here");
	});
}
