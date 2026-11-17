import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, type TuiMouseEvent, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { renderComposerRule } from "../../packages/coding-agent/src/modes/interactive/components/composer-rule.ts";
import {
	PLAIN_SELECTOR_STYLE,
	Selector,
	type SelectorItem,
	type SelectorOptions,
} from "../../packages/coding-agent/src/modes/interactive/components/selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function makeItems(count: number, extra: (index: number) => Partial<SelectorItem<number>> = () => ({})) {
	return Array.from({ length: count }, (_, index) => ({
		id: `id-${index}`,
		value: index,
		label: `item ${index}`,
		...extra(index),
	}));
}

function makeSelector(options: Partial<SelectorOptions<number>> & { items: SelectorItem<number>[] }) {
	const events: string[] = [];
	const selector = new Selector<number>({
		style: PLAIN_SELECTOR_STYLE,
		onSelect: (item) => events.push(`select:${item.id}`),
		onConfirm: (chosen) => events.push(`confirm:${chosen.map((item) => item.id).join(",")}`),
		onCancel: () => events.push("cancel"),
		onSelectionChange: (item) => events.push(`change:${item?.id ?? "none"}`),
		...options,
	});
	return { selector, events };
}

function mouseEvent(type: TuiMouseEvent["type"], y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}

describe("selector and composer rule regressions (#5224)", () => {
	test("clicking a disabled row does not choose or toggle the previously selected row (#5224)", () => {
		const single = makeSelector({
			items: makeItems(3, (index) => ({ disabled: index === 1 })),
		});
		single.selector.render(80);
		single.selector.handleMouse(mouseEvent("press", 1));
		single.selector.handleMouse(mouseEvent("click", 1));
		assert.equal(single.selector.getSelected()?.id, "id-0");
		assert.deepEqual(single.events, []);

		const multi = makeSelector({
			mode: "multi",
			items: makeItems(3, (index) => ({ disabled: index === 1 })),
		});
		multi.selector.render(80);
		multi.selector.handleMouse(mouseEvent("press", 1));
		multi.selector.handleMouse(mouseEvent("click", 1));
		assert.equal(multi.selector.state.isChecked("id-0"), false);
		assert.deepEqual(multi.events, []);
	});

	test("Home and End jump to the first and last enabled rows across terminal sequences (#5224)", () => {
		const homeSequences = ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"];
		const endSequences = ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"];
		for (let i = 0; i < homeSequences.length; i++) {
			const { selector } = makeSelector({
				items: makeItems(5, (index) => ({ disabled: index === 0 || index === 4 })),
			});
			assert.equal(selector.getSelected()?.id, "id-1");
			selector.handleInput(endSequences[i]!);
			assert.equal(selector.getSelected()?.id, "id-3", `end sequence ${JSON.stringify(endSequences[i])}`);
			selector.handleInput(homeSequences[i]!);
			assert.equal(selector.getSelected()?.id, "id-1", `home sequence ${JSON.stringify(homeSequences[i])}`);
		}
	});

	test("mouse wheel clamps at the first and last enabled rows instead of wrapping (#5224)", () => {
		const { selector, events } = makeSelector({
			items: makeItems(4, (index) => ({ disabled: index === 3 })),
		});
		selector.render(80);
		assert.equal(selector.getSelected()?.id, "id-0");

		const upAtTop = selector.handleMouse(mouseEvent("wheel", 0, { button: "none", wheelDelta: -1 }));
		assert.equal(selector.getSelected()?.id, "id-0");
		assert.equal(upAtTop?.render, false);

		selector.handleMouse(mouseEvent("wheel", 0, { button: "none", wheelDelta: 1 }));
		assert.equal(selector.getSelected()?.id, "id-1");
		selector.handleMouse(mouseEvent("wheel", 0, { button: "none", wheelDelta: 1 }));
		assert.equal(selector.getSelected()?.id, "id-2");

		const downAtBottom = selector.handleMouse(mouseEvent("wheel", 0, { button: "none", wheelDelta: 1 }));
		assert.equal(selector.getSelected()?.id, "id-2");
		assert.equal(downAtBottom?.render, false);
		assert.deepEqual(events, ["change:id-1", "change:id-2"]);
	});

	test("a truncated composer rule label preserves its styled bold formatting (#5224)", () => {
		const plainText = "debugger · very long session label that exceeds forty two columns";
		const styledText = `\x1b[1m${plainText}\x1b[22m`;
		const rule = renderComposerRule(42, {
			color: (text) => text,
			heavy: true,
			label: { plain: plainText, styled: styledText },
		});
		assert.equal(visibleWidth(rule), 42);
		assert.ok(rule.includes("…"), rule);
		assert.ok(rule.includes("\x1b[1m"), "truncated label retains bold SGR sequence");
	});
});
