import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";

/** An engine client that records the exports it is asked for. */
function exportingClient() {
	const exports: { outputPath?: string; themeName?: string }[] = [];
	const client = {
		onInteractiveEngineMessage: () => () => {},
		onEvent: () => () => {},
		onGenerationEnded: () => () => {},
		getGeneration: () => 1,
		getState: async () => ({}),
		requestInternal: async () => undefined,
		exportHtml: async (outputPath?: string, options: { themeName?: string } = {}) => {
			exports.push({ ...(outputPath === undefined ? {} : { outputPath }), ...options });
			return { path: outputPath ?? "engine-default.html" };
		},
		stop: async () => {},
		restart: async () => {},
	};
	return { client, exports };
}

function isolatedRuntime(harness: Harness, client: ReturnType<typeof exportingClient>["client"]) {
	const localRuntime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	return new IsolatedInteractiveRuntime(
		localRuntime,
		async () => {
			throw new Error("unused isolated runtime factory");
		},
		client as never,
	);
}

test("/export to HTML on the isolated host is written by the engine, which holds the tool renderers, with the chosen theme (#5525)", async () => {
	const harness = await createHarness();
	const dir = mkdtempSync(join(tmpdir(), "atomic-isolated-export-"));
	try {
		const probe = exportingClient();
		const runtime = isolatedRuntime(harness, probe.client);
		// A path relative to the host's working directory, as typed after /export.
		const typed = relative(process.cwd(), join(dir, "page.html"));
		const path = await runtime.session.exportToHtml(typed, { themeName: "light" });
		// The host has no extensions, so it leaves the page to the engine, at the path the user named from the host's
		// working directory.
		assert.deepEqual(probe.exports, [{ outputPath: join(dir, "page.html"), themeName: "light" }]);
		assert.equal(path, join(dir, "page.html"));
		assert.equal(existsSync(join(dir, "page.html")), false, "the host writes no page of its own");

		await runtime.session.exportToHtml();
		const named = probe.exports[1]?.outputPath ?? "";
		assert.equal(resolve(named), named, "the default name is resolved on the host too");
		assert.match(named, /-session-.+\.html$/);
		await runtime.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await harness.cleanup();
	}
});
