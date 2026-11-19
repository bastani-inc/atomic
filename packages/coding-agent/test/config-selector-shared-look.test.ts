import assert from "node:assert/strict";
import { join } from "node:path";
import { setKeybindings, stripTerminalSequences, TuiMainScreen, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
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
	return { extensions: [], skills: [], prompts: [], themes: [], legacyWorkflowFiles: [], mcpServers: [] };
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

	it("says how many rows are out of view instead of a position counter, counting only items (#5256)", () => {
		const multiSubgroup: ResourceGroup[] = [
			{
				key: "g",
				label: "npm:@acme/tools",
				scope: "user",
				origin: "package",
				source: "npm:@acme/tools",
				subgroups: Array.from({ length: 4 }, (_, s) => ({
					key: `s${s}`,
					label: `Type${s}`,
					type: "extensions" as never,
					items: Array.from({ length: 6 }, (_, i) => ({
						path: `/x/e${s}-${i}.ts`,
						enabled: i % 2 === 0,
						metadata: {} as never,
						resourceType: "extensions" as never,
						displayName: `ext-${s}-${i}`,
						groupKey: "g",
						subgroupKey: `s${s}`,
					})),
				})) as never,
			},
		];
		const list = new ResourceList(multiSubgroup, {} as SettingsManager, "/cwd", "/agent", 15);
		const scrollLine = (out: string[]) => out.find((line) => /^(↑|↓) \d+ more/.test(line.trim()))?.trim();
		const initial = render(list);
		assert.ok(!initial.some((line) => /\(\d+\/\d+\)/.test(line)), initial.join("\n"));
		assert.equal(scrollLine(initial), "↓ 21 more");
		for (let i = 0; i < 12; i++) list.handleInput("\x1b[B");
		assert.equal(scrollLine(render(list)), "↑ 11 more · ↓ 9 more");
	});

	it("pins the scope header and key hint line in TuiMainScreen on long lists and updates esc clear/close (#5256)", async () => {
		const resolved = (count: number) =>
			({
				extensions: Array.from({ length: count }, (_, i) => ({
					path: `/x/ext${i}.ts`,
					enabled: true,
					metadata: { source: "auto", scope: "user", origin: "top-level" },
				})),
				skills: [],
				prompts: [],
				themes: [],
			}) as never;
		for (const rows of [8, 10, 11, 12, 14, 24]) {
			const term = new VirtualTerminal(80, rows);
			const ui = new TuiMainScreen(term);
			const selector = new ConfigSelectorComponent(
				{ global: resolved(40), project: resolved(0) },
				{} as SettingsManager,
				"/cwd",
				"/agent",
				() => {},
				() => {},
				() => ui.requestRender(),
				rows,
			);
			ui.addChild(selector);
			ui.setFocus(selector.getResourceList());
			ui.start();
			await new Promise((r) => setTimeout(r, 30));
			for (let i = 0; i < 20; i++) term.sendInput("\x1b[B");
			await new Promise((r) => setTimeout(r, 30));
			const vp = await term.flushAndGetViewport();
			assert.ok(
				vp.some((line) => line.includes("esc close")),
				`rows=${rows}:\n${vp.join("\n")}`,
			);
			assert.ok(
				vp.some((line) => line.includes("Global resources")),
				`rows=${rows}:\n${vp.join("\n")}`,
			);
			assert.ok(
				vp.some((line) => line.includes("settings.json")),
				`rows=${rows}:\n${vp.join("\n")}`,
			);

			term.sendInput("e");
			await new Promise((r) => setTimeout(r, 30));
			const vpSearching = await term.flushAndGetViewport();
			assert.ok(
				vpSearching.some((line) => line.includes("esc clear")),
				`rows=${rows}:\n${vpSearching.join("\n")}`,
			);

			term.sendInput("\x1b");
			await new Promise((r) => setTimeout(r, 30));
			const vpCleared = await term.flushAndGetViewport();
			assert.ok(
				vpCleared.some((line) => line.includes("esc close")),
				`rows=${rows}:\n${vpCleared.join("\n")}`,
			);
			ui.stop();
		}
	});

	it.each(["\x03", "\x1b[99;5u", "\x1b[1089::99;5u", "\x1b[27;5;99~"])(
		"ctrl+c encoding %j closes immediately even with a search query (#5256)",
		(ctrlC) => {
			let closed = 0;
			const list = new ResourceList(groups(3), {} as SettingsManager, "/cwd", "/agent");
			list.onCancel = () => closed++;
			list.handleInput("e");
			list.handleInput(ctrlC);
			assert.equal(closed, 1);
		},
	);

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

	it("recomputes the config row budget when the terminal shrinks (#5256)", async () => {
		const resolved = {
			extensions: Array.from({ length: 40 }, (_, index) => ({
				path: `/x/ext${index}.ts`,
				enabled: true,
				metadata: { source: "auto", scope: "user", origin: "top-level" },
			})),
			skills: [],
			prompts: [],
			themes: [],
		} as never;
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(terminal);
		const selector = new ConfigSelectorComponent(
			{ global: resolved, project: resolved },
			{} as SettingsManager,
			"/cwd",
			"/agent",
			() => {},
			() => {},
			() => ui.requestRender(),
			24,
			"global",
			true,
			() => terminal.rows,
		);
		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
		try {
			for (let index = 0; index < 20; index++) terminal.sendInput("\x1b[B");
			await new Promise<void>((resolve) => setTimeout(resolve, 30));
			terminal.resize(80, 12);
			ui.requestRender();
			await new Promise<void>((resolve) => setTimeout(resolve, 30));
			assert.ok(selector.render(80).length <= 12);
			const viewport = await terminal.flushAndGetViewport();
			assert.ok(
				viewport.some((line) => line.includes("esc close")),
				viewport.join("\n"),
			);
			assert.ok(
				viewport.some((line) => line.includes("settings.json")),
				viewport.join("\n"),
			);
			assert.ok(
				viewport.some((line) => line.includes("❯")),
				viewport.join("\n"),
			);
		} finally {
			ui.stop();
		}
	});

	it("renders no more lines than the terminal has rows at every height from 7 to 40 (#5256)", () => {
		const resolved = (count: number) =>
			({
				extensions: Array.from({ length: count }, (_, i) => ({
					path: `/x/ext${i}.ts`,
					enabled: true,
					metadata: { source: "auto", scope: "user", origin: "top-level" },
				})),
				skills: [],
				prompts: [],
				themes: [],
			}) as never;
		for (const count of [0, 1, 43]) {
			for (const width of [30, 80]) {
				for (let rows = 7; rows <= 40; rows++) {
					for (const mode of ["top", "bottom", "query"] as const) {
						const selector = new ConfigSelectorComponent(
							{ global: resolved(count), project: resolved(0) },
							{} as SettingsManager,
							"/cwd",
							"/agent",
							() => {},
							() => {},
							() => {},
							rows,
						);
						const list = selector.getResourceList();
						if (mode === "bottom") for (let i = 0; i < count + 5; i++) list.handleInput("\x1b[B");
						if (mode === "query") for (const key of "ext") list.handleInput(key);
						const lines = selector.render(width).map((line) => stripTerminalSequences(line));
						const tag = `${width}x${rows} n=${count} ${mode}`;
						assert.ok(lines.length <= rows, `${tag}: ${lines.length} lines`);
						assert.ok(
							lines.some((line) => line.includes("Global resources")),
							`${tag}: title`,
						);
					}
				}
			}
		}
	});

	it("fits the complete config frame after a narrow resize (#5256)", () => {
		const empty = { extensions: [], skills: [], prompts: [], themes: [], legacyWorkflowFiles: [], mcpServers: [] };
		const selector = new ConfigSelectorComponent(
			{ global: empty, project: empty },
			{} as SettingsManager,
			"/cwd",
			"/agent",
			() => {},
			() => {},
			() => {},
			12,
		);
		for (const width of [1, 2, 8, 10, 20, 40]) {
			for (const line of selector.render(width)) {
				assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
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
		assert.ok(out.includes(join("/custom/agent-a", "settings.json")), out.join("\n"));
		assert.ok(!out.some((line) => line.includes("~/.atomic/agent/settings.json")));
		assert.ok(!out.some((line) => line.includes("Global resources") && line.includes("esc")));
	});
});
