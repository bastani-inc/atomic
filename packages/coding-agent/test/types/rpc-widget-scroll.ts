import type { RpcExtensionUIRequest } from "../../src/modes/rpc/rpc-types.js";

// PR #3022: typed RPC hosts can consume the same optional fractional cap as widget options.
const fractional: RpcExtensionUIRequest = {
	type: "extension_ui_request",
	id: "fractional",
	method: "setWidget",
	widgetKey: "workflows",
	widgetLines: [" first ", " first "],
	widgetScroll: { maxHeight: 10, maxHeightFraction: 1 / 3 },
};
const fixed: RpcExtensionUIRequest = { ...fractional, widgetScroll: { maxHeight: 10 } };
const legacy: RpcExtensionUIRequest = { ...fractional, widgetScroll: undefined };
void [fractional, fixed, legacy];
