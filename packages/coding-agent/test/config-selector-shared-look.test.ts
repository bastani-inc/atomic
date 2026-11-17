import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { type ResourceGroup, ResourceList } from "../src/modes/interactive/components/config-selector-list.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function groups(count: number): ResourceGroup[] {
	return [
		{
			key: "g",
			label: "npm:@acme/tools",
			scope: "user",
			origin: "package",
			source: "npm:@acme/tools",
			subgroups: [
				{
					key: "s",
					label: "Extensions",
					type: "extensions",
					items: Array.from({ length: count }, (_, index) => ({
						path: `/x/ext${index}.ts`,
						enabled: index % 2 === 0,
						metadata: {} as never,
						resourceType: "extensions" as never,
						displayName: `ext${index}`,
						groupKey: "g",
						subgroupKey: "s",
					})),
				} as never,
			],
		},
	];
}

function emptyPaths(): ResolvedPaths {
	return { extensions: [], skills: [], prompts: [], themes: [], workflows: [], mcpServers: [] };
}

function render(list: ResourceList, width = 100): string[] {
	return list.render(width).map((line) => stripTerminalSequences(line).replace(/\s+$/, ""));
}

describe("package and resource picker on the shared look (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("has the rounded search box, the ❯ marker and the shared checkboxes", () => {
		const list = new ResourceList(groups(3), {} as SettingsManager, "/cwd", "/agent");
		const out = render(list);
		assert.ok(
			out.some((line) => line.includes("⌕") && line.includes("Search…")),
			out.join("\n"),
		);
		assert.ok(
			out.some((line) => /❯ +\[✓\] ext0/.test(line)),
			out.join("\n"),
		);
		assert.ok(
			out.some((line) => /\[ \] ext1/.test(line)),
			out.join("\n"),
		);
	});

	it("says how many rows are out of view instead of a position counter", () => {
		const list = new ResourceList(groups(40), {} as SettingsManager, "/cwd", "/agent", 20);
		const out = render(list);
		assert.ok(!out.some((line) => /\(\d+\/\d+\)/.test(line)), out.join("\n"));
		assert.ok(
			out.some((line) => /^↓ \d+ more$/.test(line.trim())),
			out.join("\n"),
		);
	});

	it("fits the search box, scrolling hints and empty states after a narrow resize (#5256)", () => {
		const list = new ResourceList(groups(40), {} as SettingsManager, "/cwd", "/agent", 20);
		for (let index = 0; index < 18; index++) list.handleInput("\x1b[B");
		for (const query of ["", "missing-resource"]) {
			for (const key of query) list.handleInput(key);
			for (const width of [1, 2, 8, 10, 20, 40]) {
				for (const line of list.render(width)) {
					assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
				}
			}
		}
	});

	it("esc clears a search before it closes", () => {
		let closed = 0;
		const list = new ResourceList(groups(3), {} as SettingsManager, "/cwd", "/agent");
		list.onCancel = () => closed++;
		list.handleInput("e");
		list.handleInput("\x1b");
		assert.equal(closed, 0);
		list.handleInput("\x1b");
		assert.equal(closed, 1);
	});

	for (const width of [80, 160]) {
		it(`ends with one hint line naming exactly its live keys at ${width} columns`, () => {
			const list = new ResourceList(groups(3), {} as SettingsManager, "/cwd", "/agent");
			assert.equal(
				render(list, width).at(-1)?.trim(),
				"↑↓ select · space/enter toggle · type to search · esc close",
			);
			list.onSwitchMode = () => {};
			assert.equal(
				render(list, width).at(-1)?.trim(),
				"↑↓ select · space/enter toggle · tab switch scope · type to search · esc close",
			);
			for (const key of "ext1") list.handleInput(key);
			assert.equal(
				render(list, width).at(-1)?.trim(),
				"space/enter toggle · tab switch scope · type to search · esc clear",
			);
			assert.ok(render(list, width).every((line) => visibleWidth(line) <= width));
		});
	}

	it("names the settings file of the agent directory in use, not a fixed home path", () => {
		const header = new ConfigSelectorComponent(
			{ global: emptyPaths(), project: emptyPaths() },
			{} as SettingsManager,
			"/cwd",
			"/custom/agent-a",
			() => {},
			() => {},
			() => {},
		);
		const out = header.render(100).map((line) => stripTerminalSequences(line).trim());
		assert.ok(out.includes("Global resources"), out.join("\n"));
		assert.ok(out.includes("/custom/agent-a/settings.json"), out.join("\n"));
		assert.ok(!out.some((line) => line.includes("~/.atomic/agent/settings.json")));
		assert.ok(!out.some((line) => line.includes("Global resources") && line.includes("esc")));
	});
});
