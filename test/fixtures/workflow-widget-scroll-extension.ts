import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/index.js";
import factory from "../../packages/workflows/src/extension/extension-factory.js";
import type { ExtensionAPI as WorkflowAPI } from "../../packages/workflows/src/extension/public-types.js";
import { store } from "../../packages/workflows/src/shared/store.js";

/** Dedicated terminal scenario with actual workflow registration and no model calls. */
export default function workflowWidgetScrollFixture(pi: ExtensionAPI): void {
	factory(pi as unknown as WorkflowAPI);
	pi.on("session_start", (_event, ctx) => {
		for (let i = 0; i < 15; i++) {
			store.recordRunStart({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `SCROLL WORKFLOW ${i}`, status: "paused", startedAt: Date.now() + i, inputs: {}, stages: [] });
		}
		ctx.ui.setEditorText("typing stays here");
	});
}
