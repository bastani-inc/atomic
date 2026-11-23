import assert from "node:assert/strict";
import { setKeybindings, type TUI } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "./helpers/visible-text.js";

function lines(selector: ExtensionSelectorComponent, width = 80): string[] {
	return stripAnsi(selector.render(width).join("\n")).split("\n");
}

function render(selector: ExtensionSelectorComponent): string {
	return lines(selector).join("\n");
}

function visibleOptions(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("option-"))
		.map((line) => line.trim().replace(/^∀ /, ""));
}

function hint(selector: ExtensionSelectorComponent, width = 80): string {
	return lines(selector, width).at(-2)?.trim() ?? "";
}

function choose(options: string[], extra?: ConstructorParameters<typeof ExtensionSelectorComponent>[4]) {
	const onSelect = vi.fn();
	const onCancel = vi.fn();
	const selector = new ExtensionSelectorComponent("Choose", options, onSelect, onCancel, extra);
	return { selector, onSelect, onCancel };
}

describe("extension selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the selection inside the window of a long option list (pi #6688)", () => {
		const options = Array.from({ length: 15 }, (_, index) => `option-${index + 1}`);
		const { selector } = choose(options);

		let output = render(selector);
		assert.deepEqual(visibleOptions(output), options.slice(0, 10));
		assert.ok(output.includes("∀ option-1"));
		assert.ok(output.includes("↓ 5 more"));
		assert.ok(!/↑ \d+ more/.test(output));

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		assert.ok(visibleOptions(output).includes("option-8"));
		assert.ok(output.includes("∀ option-8"));

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		assert.deepEqual(visibleOptions(output), options.slice(5, 15));
		assert.ok(output.includes("∀ option-15"));
		assert.ok(output.includes("↑ 5 more"));
		assert.ok(!/↓ \d+ more/.test(output));
	});

	it("shows a scroll indicator for exactly eleven options and not for ten", () => {
		const eleven = Array.from({ length: 11 }, (_, index) => `option-${index + 1}`);
		assert.ok(render(choose(eleven).selector).includes("↓ 1 more"));
		const ten = eleven.slice(0, 10);
		const tenOutput = render(choose(ten).selector);
		assert.deepEqual(visibleOptions(tenOutput), ten);
		assert.ok(!tenOutput.includes("more"));
	});

	it("renders short and empty option lists without a scroll indicator", () => {
		const shortOptions = ["option-1", "option-2", "option-3"];
		const shortOutput = render(choose(shortOptions).selector);
		assert.deepEqual(visibleOptions(shortOutput), shortOptions);
		assert.ok(shortOutput.includes("∀ option-1"));
		assert.ok(!shortOutput.includes("more"));

		const empty = choose([]).selector;
		const emptyOutput = render(empty);
		assert.ok(emptyOutput.includes("Choose"));
		assert.ok(emptyOutput.includes("Nothing to choose from"));
		assert.ok(!emptyOutput.includes("∀"));
		assert.equal(hint(empty), "esc cancel · ? keys");
	});

	it("chooses with enter, moves with ↑↓ and j/k, and cancels with esc (#5224)", () => {
		const { selector, onSelect, onCancel } = choose(["Yes", "No", "Later"]);
		assert.equal(hint(selector), "↑↓ select · enter choose · esc cancel · ? keys");
		selector.handleInput("j");
		selector.handleInput("j");
		selector.handleInput("k");
		selector.handleInput("\r");
		assert.deepEqual(onSelect.mock.calls, [["No"]]);
		selector.handleInput("\x1b");
		assert.equal(onCancel.mock.calls.length, 0);
		const cancelled = choose(["Yes", "No", "Later"]);
		cancelled.selector.handleInput("\x1b");
		assert.equal(cancelled.onCancel.mock.calls.length, 1);
	});

	it("shows the first title line as the title and the rest as dim lines under it (#5224)", () => {
		const { selector } = choose(["Yes", "No"]);
		const confirm = new ExtensionSelectorComponent(
			"Delete branch?\nThis removes feat/x from origin.",
			["Yes", "No"],
			() => {},
			() => {},
		);
		const out = lines(confirm);
		assert.equal(out[1], "  Delete branch?");
		assert.equal(out[2], "  This removes feat/x from origin.");
		assert.equal(lines(selector)[1], "  Choose");
		for (const width of [40, 80, 160]) {
			for (const line of lines(confirm, width)) assert.ok(line.length <= width, `${width}: ${line}`);
		}
	});

	it("lists ctrl+o in the hint only when it toggles tool output, and runs it", () => {
		const onToggleToolsExpanded = vi.fn();
		const { selector } = choose(["Yes", "No"], { onToggleToolsExpanded });
		assert.equal(hint(selector, 120), "↑↓ select · enter choose · ctrl+o tool output · esc cancel · ? keys");
		selector.handleInput("\x0f");
		assert.equal(onToggleToolsExpanded.mock.calls.length, 1);
		assert.ok(!hint(choose(["Yes", "No"]).selector, 120).includes("ctrl+o"));
	});

	it("counts the timeout down in the title and cancels when it runs out", () => {
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const { selector, onCancel } = choose(["Yes", "No"], { tui, timeout: 2000 });
		assert.equal(lines(selector)[1], "  Choose (2s)");
		vi.advanceTimersByTime(1000);
		assert.equal(lines(selector)[1], "  Choose (1s)");
		vi.advanceTimersByTime(1000);
		assert.equal(onCancel.mock.calls.length, 1);
		selector.dispose();
	});

	it("numbers the options of a permission prompt so a digit answers it (#5224)", () => {
		const { selector, onSelect } = choose(["Yes", "No"], { numbered: true });
		const out = lines(selector);
		assert.ok(out.includes(" ∀ 1. Yes"), out.join("\n"));
		assert.ok(out.includes("   2. No"), out.join("\n"));
		assert.equal(hint(selector), "↑↓ select · enter choose · 1-2 pick · esc cancel · ? keys");
		selector.handleInput("2");
		assert.deepEqual(onSelect.mock.calls, [["No"]]);
	});

	it("wraps long titles and options across lines instead of truncating paths and commands (#5237)", () => {
		const missingCwdTitle =
			"Session cwd does not exist: /home/user/projects/some-very-long-client-name/monorepo/packages/service-a";
		const missingCwdOptions = [
			"Continue in /home/user/projects/another-very-long-directory-name/current-working-dir (asks again next time)",
			"Fork into /home/user/projects/another-very-long-directory-name/current-working-dir (new session ID, original kept)",
			"Cancel",
		];
		for (const width of [80, 100]) {
			const selected: string[] = [];
			const cwdSelector = new ExtensionSelectorComponent(
				missingCwdTitle,
				missingCwdOptions,
				(option) => selected.push(option),
				() => {},
			);
			const rendered = lines(cwdSelector, width);
			const normalized = rendered.join("\n").replace(/\s+/g, " ");
			assert.ok(normalized.includes(missingCwdTitle), `missing title at width ${width}: ${normalized}`);
			for (const option of missingCwdOptions) {
				assert.ok(normalized.includes(option), `missing option at width ${width}: ${option}`);
			}
			for (const line of rendered) assert.ok(line.length <= width, `${width}: ${line}`);
			const continuationY = rendered.findIndex((line) => line.includes("original kept"));
			assert.ok(continuationY >= 0);
			cwdSelector.handleMouse({
				type: "press",
				button: "left",
				x: 4,
				y: continuationY,
				screenX: 4,
				screenY: continuationY,
				width,
				height: rendered.length,
				shift: false,
				alt: false,
				ctrl: false,
			});
			cwdSelector.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y: continuationY,
				screenX: 4,
				screenY: continuationY,
				width,
				height: rendered.length,
				shift: false,
				alt: false,
				ctrl: false,
			});
			assert.deepEqual(selected, [missingCwdOptions[1]]);
		}

		const deployTitle =
			"The deploy extension wants to run: kubectl --context prod-eu-west-1 rollout restart deployment/payments-api -n payments";
		const deployOptions = [
			"Run it now in production",
			"Run it in staging first (kubectl --context staging-eu-west-1 rollout restart ...)",
			"Skip",
		];
		for (const width of [60, 80, 100]) {
			const deploySelector = new ExtensionSelectorComponent(
				deployTitle,
				deployOptions,
				() => {},
				() => {},
			);
			const rendered = lines(deploySelector, width);
			const normalized = rendered.join("\n").replace(/\s+/g, " ");
			assert.ok(normalized.includes(deployTitle), `missing deploy title at width ${width}: ${normalized}`);
			for (const option of deployOptions) {
				assert.ok(normalized.includes(option), `missing deploy option at width ${width}: ${option}`);
			}
			for (const line of rendered) assert.ok(line.length <= width, `${width}: ${line}`);
		}
	});
});
