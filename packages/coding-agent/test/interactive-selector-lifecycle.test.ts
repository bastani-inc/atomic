import { expect, test, vi } from "vitest";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-selectors.ts";

type SelectorResult = { component: object; focus: object; dispose?: () => void };

type SelectorHarness = {
	activeSelectorToken: object | undefined;
	activeSelectorDispose: (() => void) | undefined;
	editor: object;
	editorContainer: { clear: () => void; addChild: (component: object) => void };
	ui: { setFocus: (component: object) => void; requestRender: () => void };
};

const showSelector = InteractiveModeBase.prototype.showSelector as unknown as (
	this: SelectorHarness,
	create: (done: () => void) => SelectorResult,
) => void;

function createHarness() {
	const editor = { name: "editor" };
	const children: object[] = [editor];
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const harness = Object.assign(Object.create(InteractiveModeBase.prototype), {
		activeSelectorToken: undefined,
		activeSelectorDispose: undefined,
		editor,
		editorContainer: {
			clear: () => children.splice(0),
			addChild: (component: object) => children.push(component),
		},
		ui: { setFocus, requestRender },
	}) as SelectorHarness;
	return { harness, editor, children, setFocus, requestRender };
}

test("a stale selector completion cannot reclaim the editor or dispose twice", () => {
	const { harness, editor, children, setFocus } = createHarness();
	const first = { name: "first" };
	const second = { name: "second" };
	const disposeFirst = vi.fn();
	const disposeSecond = vi.fn();
	let finishFirst!: () => void;
	let finishSecond!: () => void;

	showSelector.call(harness, (done) => {
		finishFirst = done;
		return { component: first, focus: first, dispose: disposeFirst };
	});
	showSelector.call(harness, (done) => {
		finishSecond = done;
		return { component: second, focus: second, dispose: disposeSecond };
	});

	expect(disposeFirst).toHaveBeenCalledOnce();
	finishFirst();
	expect(disposeFirst).toHaveBeenCalledOnce();
	expect(children).toEqual([second]);
	expect(setFocus).toHaveBeenLastCalledWith(second);

	finishSecond();
	expect(disposeSecond).toHaveBeenCalledOnce();
	expect(children).toEqual([editor]);
});

test("does not mount a selector that completes during creation", () => {
	const { harness, editor, children, requestRender } = createHarness();
	const selector = { name: "complete-before-mount" };
	const dispose = vi.fn();

	showSelector.call(harness, (done) => {
		done();
		return { component: selector, focus: selector, dispose };
	});

	expect(dispose).toHaveBeenCalledOnce();
	expect(children).toEqual([editor]);
	expect(requestRender).not.toHaveBeenCalled();
});
