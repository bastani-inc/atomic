import { keybindingIdentity } from "@bastani/atomic";
import { getKeybindings, type KeybindingsConfig, matchesKey } from "@earendil-works/pi-tui";

// Distinct key ids can share raw control bytes or ESC-prefixed legacy inputs.
// Ask the parser in its current protocol/environment mode rather than equating
// those ids: their explicit CSI-u/modifyOtherKeys inputs can remain distinct.
const legacyInputs = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)).flatMap((data) => [
	data,
	`\x1b${data}`,
]);

export function workflowScrollHint(
	bindings: KeybindingsConfig = getKeybindings().getResolvedBindings(),
	platform = process.platform,
): string {
	const keys = ["app.workflows.scrollUp", "app.workflows.scrollDown"]
		.map((action) => {
			const configured = bindings[action] ?? [];
			return (Array.isArray(configured) ? configured : [configured]).find((key) => {
				const inputs = legacyInputs.filter((data) => matchesKey(data, key));
				return !Object.entries(bindings).some(
					([other, values]) =>
						other !== action &&
						(Array.isArray(values) ? values : [values]).some(
							(value) =>
								value !== undefined &&
								(keybindingIdentity(value) === keybindingIdentity(key) ||
									inputs.some((data) => matchesKey(data, value))),
						),
				);
			});
		})
		.filter((key) => key !== undefined);
	const label = keys.map((key) => key.replace(/^alt\+/i, platform === "darwin" ? "Option+" : "Alt+")).join("/");
	return ` ${label ? `${label} · ` : ""}Wheel scroll workflows`;
}
