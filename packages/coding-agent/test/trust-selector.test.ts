import { dirname, resolve } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "./helpers/visible-text.js";

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the saved trusted decision marked while browsing", () => {
		const projectPath = resolve("/project");
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			trustPath: projectPath,
			savedDecision: { path: projectPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (${projectPath})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toMatch(/^ ❯ 1\. ● Trust +saved$/m);

		selector.handleInput("\x1b[B");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toMatch(/^ {3}1\. ● Trust +saved$/m);
		expect(output).toContain(` ❯ 2. ○ Trust parent folder (${dirname(projectPath)})`);
		expect(output).toContain("   3. ○ Do not trust");
	});

	it("uses the shared selector keys: j/k move, digits pick, and the hint lists exactly them (#5224)", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const projectPath = resolve("/project");
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			trustPath: projectPath,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel,
		});
		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		expect(lines.at(-2)?.trim()).toBe("↑↓ select · enter save · 1-3 pick · esc cancel · ? keys");
		expect(lines.some((line) => line.includes("saved"))).toBe(false);
		expect(lines.some((line) => /[●○]/.test(line))).toBe(false);

		selector.handleInput("j");
		selector.handleInput("j");
		selector.handleInput("k");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenLastCalledWith({
			trusted: true,
			updates: [
				{ path: dirname(projectPath), decision: true },
				{ path: projectPath, decision: null },
			],
		});
		selector.handleInput("3");
		selector.handleInput("\x1b");
		expect(onSelect).toHaveBeenCalledOnce();
		expect(onCancel).not.toHaveBeenCalled();
		const numbered = new TrustSelectorComponent({
			cwd: projectPath,
			trustPath: projectPath,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel,
		});
		numbered.handleInput("3");
		expect(onSelect).toHaveBeenLastCalledWith({ trusted: false, updates: [{ path: projectPath, decision: false }] });
		const cancelled = new TrustSelectorComponent({
			cwd: projectPath,
			trustPath: projectPath,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel,
		});
		cancelled.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
		for (const width of [40, 80, 160]) {
			for (const line of selector.render(width)) expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
		}
	});

	it("selects a trust decision", () => {
		const onSelect = vi.fn();
		const projectPath = resolve("/project");
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			trustPath: projectPath,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ trusted: true, updates: [{ path: projectPath, decision: true }] });
	});

	it("labels saved ancestor decisions as inherited", () => {
		const nestedPath = resolve("/parent/project/nested");
		const ancestorPath = resolve("/parent");
		const selector = new TrustSelectorComponent({
			cwd: nestedPath,
			trustPath: nestedPath,
			savedDecision: { path: ancestorPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (inherited from ${ancestorPath})`);
	});

	it("adds a trust parent option", () => {
		const onSelect = vi.fn();
		const projectPath = resolve("/parent/project");
		const parentPath = dirname(projectPath);
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			trustPath: projectPath,
			savedDecision: { path: parentPath, decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${parentPath})`);
		expect(output).toMatch(new RegExp(`● Trust parent folder \\(${parentPath.replace(/[\\/]/g, "\\$&")}\\) +saved`));

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: projectPath, decision: null },
			],
		});
	});
});
