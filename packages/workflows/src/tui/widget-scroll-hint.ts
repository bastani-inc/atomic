import { getKeybindings, type KeybindingsConfig } from "@earendil-works/pi-tui";

export function workflowScrollHint(
	bindings: KeybindingsConfig = getKeybindings().getResolvedBindings(),
	platform = process.platform,
): string {
	const keys = ["app.workflows.scrollUp", "app.workflows.scrollDown"]
		.map((action) => {
			const configured = bindings[action] ?? [];
			return (Array.isArray(configured) ? configured : [configured]).find(
				(key) =>
					!Object.entries(bindings).some(
						([other, values]) =>
							other !== action &&
							(Array.isArray(values) ? values : [values]).some(
								(value) => value?.toLowerCase() === key.toLowerCase(),
							),
					),
			);
		})
		.filter((key) => key !== undefined);
	const label = keys.map((key) => key.replace(/^alt\+/i, platform === "darwin" ? "Option+" : "Alt+")).join("/");
	return ` ${label ? `${label} · ` : ""}Wheel scroll workflows`;
}
