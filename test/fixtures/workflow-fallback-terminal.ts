import { makeFakeKeybindings as s5aKeybindings } from "../support/fake-keybindings.js";
// Run: bun test/fixtures/workflow-fallback-terminal.ts in a dedicated terminal.
// Press f three times: B-fast/medium, B-fast/low, C:literal/off. Arrows navigate; q exits.
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { subscribeStoreInvalidation } from "../../packages/workflows/src/shared/store-observation.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { startFallbackWidgetScenario } from "../helpers/workflow-fallback-widget.js";

const scenario = await startFallbackWidgetScenario();
const tui = new TuiMainScreen(new ProcessTerminal());
const closed = Promise.withResolvers<void>();
const view = new GraphView({
	piKeybindings: s5aKeybindings(),
	mode: "overlay", runId: scenario.runId, store: scenario.store, graphTheme: deriveGraphTheme({}),
	piTui: tui, requestRender: () => tui.requestRender(),
});
const unsubscribe = subscribeStoreInvalidation(scenario.store, () => tui.requestRender());
const component = {
	render: (width: number) => view.render(width),
	invalidate: () => view.invalidate(),
	handleInput(data: string) {
		if (data === "q" || data === "\x03") { closed.resolve(); return true; }
		if (data === "f") {
			void scenario.apply().catch((error: Error) => closed.reject(error));
			return true;
		}
		return view.handleInput(data);
	},
};
tui.addChild(component);
tui.setFocus(component);
tui.start();
try {
	await closed.promise;
} finally {
	unsubscribe();
	view.dispose();
	tui.stop();
	await scenario.finish();
}
