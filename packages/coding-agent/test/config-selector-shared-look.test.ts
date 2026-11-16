import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
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
		const last = render(list).at(-1)!;
		assert.ok(!/\(\d+\/\d+\)/.test(last), last);
		assert.match(last.trim(), /^↓ \d+ more$/);
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
});
