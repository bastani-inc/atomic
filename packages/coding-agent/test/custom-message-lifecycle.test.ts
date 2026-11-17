import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark", false));
const message = {
	role: "custom" as const,
	customType: "private_fixture",
	content: "private model-facing body",
	display: true,
	timestamp: 1,
};

test("custom message renderers can retain their component across expansion without premature disposal (#5350)", () => {
	let closed = false;
	let releases = 0;
	const retained = {
		render: () => {
			assert.equal(closed, false);
			return ["projected body"];
		},
		invalidate() {},
		dispose() {
			closed = true;
			releases++;
		},
	};
	const component = new CustomMessageComponent(message, () => retained);
	try {
		component.render(80);
		component.setExpanded(true);
		assert.match(component.render(80).join("\n"), /projected body/);
		assert.equal(releases, 0);
	} finally {
		component.dispose();
	}
	assert.equal(releases, 1);
	assert.deepEqual(component.render(80), []);
});

test("failed custom message renderers keep their raw body private (#5350)", () => {
	const component = new CustomMessageComponent(message, () => {
		throw new Error("private renderer exception");
	});
	try {
		const text = component.render(80).map(stripTerminalSequences).join("\n");
		assert.match(text, /✗ Message renderer failed/);
		assert.doesNotMatch(text, /private model-facing body|private renderer exception/);
	} finally {
		component.dispose();
	}
});
