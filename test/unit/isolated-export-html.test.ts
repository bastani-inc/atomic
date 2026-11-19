import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";
import type { RpcCommand } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";

/** Deliver the host's export request to a real engine command handler without spawning a second process. */
function isolatedRuntime(harness: Harness) {
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
	const handle = createRpcCommandHandler({
		runtimeHost: localRuntime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: () => {},
	});
	const client = {
		onInteractiveEngineMessage: () => () => {},
		onEvent: () => () => {},
		onGenerationEnded: () => () => {},
		getGeneration: () => 1,
		getState: async () => ({}),
		requestInternal: async (command: RpcCommand) => {
			if (command.type !== "render_html") return undefined;
			const result = await handle(command);
			assert.ok(result?.success, result && !result.success ? result.error : "missing RPC response");
			return "data" in result ? result.data : undefined;
		},
		stop: async () => {},
		restart: async () => {},
	};
	return new IsolatedInteractiveRuntime(
		localRuntime,
		async () => {
			throw new Error("unused isolated runtime factory");
		},
		client as never,
	);
}

test("isolated /export writes the engine's page and chosen theme at the host's destination (#5525)", async () => {
	const harness = await createHarness();
	const dir = mkdtempSync(join(tmpdir(), "atomic-isolated-export-"));
	let defaultPath: string | undefined;
	try {
		const typed = relative(process.cwd(), join(dir, "page.html"));
		// The in-process export has the session and tool renderers that the isolated host asks its engine for.
		const reference = await harness.session.exportToHtml(join(dir, "expected.html"), { themeName: "light" });
		const runtime = isolatedRuntime(harness);
		assert.equal(await runtime.session.exportToHtml(typed, { themeName: "light" }), typed);
		assert.equal(readFileSync(typed, "utf8"), readFileSync(reference, "utf8"));
		defaultPath = await runtime.session.exportToHtml();
		assert.match(defaultPath, /^[^/\\]+-session-[^/\\]+\.html$/);
		assert.match(readFileSync(defaultPath, "utf8"), /<html/i);
		const missing = relative(process.cwd(), join(dir, "missing", "report.html"));
		await assert.rejects(runtime.session.exportToHtml(missing), { code: "ENOENT", path: missing });
		await runtime.dispose();
	} finally {
		if (defaultPath) rmSync(defaultPath, { force: true });
		rmSync(dir, { recursive: true, force: true });
		await harness.cleanup();
	}
});

test.skipIf(process.platform !== "linux")(
	"isolated /export accepts a relative path just below PATH_MAX (#5531)",
	async () => {
		const harness = await createHarness();
		const dir = mkdtempSync(join(tmpdir(), "atomic-export-long-"));
		try {
			const file = join(dir, "report.html");
			const name = relative(process.cwd(), file);
			// These existing components keep the destination unchanged while exercising the kernel's 4096-byte pathname limit.
			const typed = "./".repeat(Math.floor((4095 - Buffer.byteLength(name)) / 2)) + name;
			const runtime = isolatedRuntime(harness);
			assert.equal(await runtime.session.exportToHtml(typed), typed);
			assert.match(readFileSync(file, "utf8"), /<html/i);
			await runtime.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await harness.cleanup();
		}
	},
);

// Windows resolves `..` in a path before it follows a link, so there the path below names the `report.html` beside
// the link.
test.skipIf(process.platform === "win32")(
	"/export through a linked directory and `..` on the isolated host writes where the in-process export does (#5531)",
	async () => {
		const harness = await createHarness();
		const dir = mkdtempSync(join(tmpdir(), "atomic-isolated-export-link-"));
		try {
			mkdirSync(join(dir, "physical", "deep"), { recursive: true });
			symlinkSync(join("physical", "deep"), join(dir, "link"));
			writeFileSync(join(dir, "report.html"), "someone else's page");
			const runtime = isolatedRuntime(harness);
			const typed = `${relative(process.cwd(), join(dir, "link"))}${sep}..${sep}report.html`;
			assert.equal(await runtime.session.exportToHtml(typed), typed);
			assert.match(readFileSync(join(dir, "physical", "report.html"), "utf8"), /<html/i);
			assert.equal(readFileSync(join(dir, "report.html"), "utf8"), "someone else's page");
			await runtime.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await harness.cleanup();
		}
	},
);
