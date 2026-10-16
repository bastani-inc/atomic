import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import preset from "../examples/extensions/preset.ts";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { StorageUnavailableError } from "../src/core/storage/session/errors.ts";
import { createTestExtensionsResult } from "./utilities.ts";

for (const via of ["selector", "shortcut"] as const) {
	test(`preset ${via} retains its instructions when restoring settings fails`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "preset-save-"));
		mkdirSync(join(directory, CONFIG_DIR_NAME));
		writeFileSync(
			join(directory, CONFIG_DIR_NAME, "presets.json"),
			JSON.stringify({ zzzz: { instructions: "Keep these instructions" } }),
		);
		const failure = new StorageUnavailableError({ adapter: "test", location: "preset" }, new Error("save failed"));
		const restore = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
		try {
			const loaded = await createTestExtensionsResult([
				(pi) =>
					preset({
						...pi,
						getThinkingLevel: () => "off",
						getActiveTools: () => [],
						setActiveTools() {},
						setThinkingLevel: restore,
					}),
			]);
			const extension = loaded.extensions[0];
			const ctx = {
				cwd: directory,
				isProjectTrusted: () => true,
				sessionManager: { getEntries: () => [] },
				ui: {
					notify() {},
					setStatus() {},
					theme: { fg: (_color: string, text: string) => text },
					custom: async () => "(none)",
				},
			} as ExtensionCommandContext;
			await extension.handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, ctx);
			const command = extension.commands.get("preset")!;
			await command.handler("zzzz", ctx);
			const clear = () =>
				via === "selector" ? command.handler("", ctx) : [...extension.shortcuts.values()][0].handler(ctx);
			await assert.rejects(
				async () => clear(),
				(error: Error) => error === failure,
			);
			const instructions = (await extension.handlers.get("before_agent_start")![0](
				{ systemPrompt: "Base" },
				ctx,
			)) as { systemPrompt?: string };
			assert.ok(instructions, "a failed restore keeps the active preset");
			assert.match(instructions.systemPrompt ?? "", /Keep these instructions/);
			await clear();
			assert.equal(restore.mock.calls.length, 2, "retry restores the same preset settings");
			assert.equal(await extension.handlers.get("before_agent_start")![0]({ systemPrompt: "Base" }, ctx), undefined);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
