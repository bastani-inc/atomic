import { type Component, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { MessageRenderer } from "../src/core/extensions/types.ts";
import { createCustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function makeMessage(customType = "workflows:input-form", content = "stack-workflow-test") {
	return createCustomMessage(customType, content, true, { formId: "wf-missing" }, new Date(0).toISOString());
}

describe("CustomMessageComponent renderer guard (issue #1236)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("does not crash when a custom renderer returns a non-Component string", () => {
		// Guard against a renderer that returns a bare string (a non-Component,
		// non-null value). Before the guard such a string was added as a child and
		// Container.render() threw "child.render is not a function"; it now falls
		// through to the default boxed rendering instead.
		const stringRenderer: MessageRenderer = () =>
			"  stack-workflow-test  ·  (snapshot lost)" as unknown as Component;
		const component = new CustomMessageComponent(makeMessage(), stringRenderer);

		let rendered = "";
		expect(() => {
			rendered = stripAnsi(component.render(80).join("\n"));
		}).not.toThrow();

		// Falls through to the default boxed rendering (label + content) instead.
		expect(rendered).toContain("[workflows:input-form]");
		expect(rendered).toContain("stack-workflow-test");
	});

	test("ignores other non-Component return shapes and falls back to default", () => {
		// `null` is intentionally excluded here: it now means "render nothing"
		// (covered by the dedicated test below), not "fall back to default".
		for (const bad of [42, true, { not: "a component" }, []]) {
			const renderer: MessageRenderer = () => bad as unknown as Component;
			const component = new CustomMessageComponent(makeMessage("my-type", "body text"), renderer);
			let rendered = "";
			expect(() => {
				rendered = stripAnsi(component.render(80).join("\n"));
			}).not.toThrow();
			expect(rendered).toContain("[my-type]");
		}
	});

	test("renders nothing (no spacer, no default box) when the renderer returns null", () => {
		// `null` = "handled; render nothing". The workflows inline-form renderer
		// returns null for a rehydrated input-form card on /resume so the input
		// widget must not reappear in chat. The entry must occupy zero rows — not
		// even the leading spacer the default rendering path adds.
		const renderer: MessageRenderer = () => null;
		const component = new CustomMessageComponent(makeMessage("my-type", "body text"), renderer);
		let rendered = "";
		expect(() => {
			rendered = stripAnsi(component.render(80).join("\n"));
		}).not.toThrow();
		expect(rendered.trim()).toBe("");
		expect(rendered).not.toContain("[my-type]");
	});

	test("mounts a valid Component returned by the custom renderer", () => {
		const renderer: MessageRenderer = () => new Text("hello-from-renderer", 0, 0);
		const component = new CustomMessageComponent(makeMessage(), renderer);
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("hello-from-renderer");
		// The custom component owns its styling, so the default label is absent.
		expect(rendered).not.toContain("[workflows:input-form]");
	});
});
