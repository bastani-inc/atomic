/**
 * Regression: MCP deferred init must treat a stale extension context as a
 * cancellation, not log "MCP initialization failed".
 *
 * Background: `perf(startup): lazy-load bundled extensions` (c7b49aaa) moved the
 * MCP `init.ts` import behind an `await` inside the `session_start` handler. That
 * added an async gap before the first `pi.getFlag("mcp-config")` call. A workflow
 * child stage `AgentSession` can be disposed directly during that gap
 * (stage-runner calls `session.dispose()` without emitting `session_shutdown`),
 * which invalidates the runtime backing the captured `pi`/`ctx` WITHOUT bumping
 * MCP's `lifecycleGeneration`. The old generation guard therefore passed and the
 * captured `pi.getFlag()`/`ctx.cwd` access threw a stale-context error that was
 * surfaced as a scary "MCP initialization failed" log.
 *
 * This test simulates that exact race: it drives the real `session_start`
 * handler, then flips the captured context to "stale" while the deferred init is
 * suspended at its async boundary, and asserts no failure is logged.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import mcpAdapter from "../../packages/mcp/index.ts";
import { stopCallbackServer } from "../../packages/mcp/mcp-callback-server.ts";
import { computeServerHash, saveMetadataCache } from "../../packages/mcp/metadata-cache.ts";
import type { ServerEntry } from "../../packages/mcp/types.ts";

// Mirror of the host stale-context error thrown by ExtensionRunner.assertActive().
const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

type SessionStartEvent = { readonly type: "session_start"; readonly reason: "startup" };
type SessionStartContext = {
	readonly cwd: string;
	readonly hasUI: false;
	readonly signal?: AbortSignal;
};
type SessionStartHandler = (event: SessionStartEvent, ctx: SessionStartContext) => Promise<void> | void;

const originalArgv = [...process.argv];
const originalAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalMcpDirectTools = process.env.MCP_DIRECT_TOOLS;

beforeEach(async () => {
	await stopCallbackServer();
});

afterEach(async () => {
	process.argv = [...originalArgv];
	if (originalAtomicAgentDir === undefined) {
		delete process.env.ATOMIC_CODING_AGENT_DIR;
	} else {
		process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	}
	if (originalMcpDirectTools === undefined) {
		delete process.env.MCP_DIRECT_TOOLS;
	} else {
		process.env.MCP_DIRECT_TOOLS = originalMcpDirectTools;
	}
	await stopCallbackServer();
});

test("MCP deferred init treats a stale context (dispose during async gap) as cancellation", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-mcp-stale-ctx-"));
	const configPath = join(tempDir, "mcp.json");
	const remoteServer = { url: "https://example.invalid/mcp" } satisfies ServerEntry;
	writeFileSync(configPath, JSON.stringify({ mcpServers: { remote: remoteServer } }));
	process.env.ATOMIC_CODING_AGENT_DIR = join(tempDir, "agent");
	process.env.MCP_DIRECT_TOOLS = "__none__";
	process.argv = [...originalArgv, "--mcp-config", configPath];

	// Pre-seed the metadata cache so the lazy server is NOT eagerly connected at
	// startup (keeps the test offline; init has no servers to dial).
	saveMetadataCache({
		version: 1,
		servers: {
			remote: {
				configHash: computeServerHash(remoteServer),
				tools: [],
				resources: [],
				cachedAt: Date.now(),
			},
		},
	});

	// The captured context starts active; flipping `stale` makes every guarded
	// access throw exactly like the host's ExtensionRunner.assertActive().
	let stale = false;
	const assertActive = (): void => {
		if (stale) throw new Error(STALE_CTX_MESSAGE);
	};
	const ctx: SessionStartContext = {
		get cwd() {
			assertActive();
			return tempDir;
		},
		hasUI: false,
		get signal() {
			assertActive();
			return undefined;
		},
	};

	const registeredTools: string[] = [];
	let sessionStart: SessionStartHandler | undefined;
	const consoleErrors: string[] = [];
	const originalConsoleError = console.error;
	console.error = (...args: Parameters<typeof console.error>) => {
		consoleErrors.push(args.map(String).join(" "));
	};

	try {
		mcpAdapter({
			registerFlag: () => {},
			registerCommand: () => {},
			registerTool: (tool: { name: string }) => {
				registeredTools.push(tool.name);
			},
			getAllTools: () => [],
			// Like the real host: reading a flag goes through the stale guard.
			getFlag: (name: string) => {
				assertActive();
				return name === "mcp-config" ? configPath : undefined;
			},
			sendMessage: () => {},
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
			on: (event: string, handler: SessionStartHandler) => {
				if (event === "session_start") sessionStart = handler;
			},
		} as never);

		assert.ok(sessionStart, "MCP adapter should register session_start");

		// Run the handler. It returns once the deferred init promise is wired up; the
		// init body is still suspended at its first async boundary at this point.
		await sessionStart({ type: "session_start", reason: "startup" }, ctx);

		// Simulate the child session being disposed during the async gap.
		stale = true;

		// Let the deferred init settle (it should bail out as a cancellation).
		await new Promise((resolve) => setTimeout(resolve, 75));

		assert.equal(
			consoleErrors.some((line) => line.includes("MCP initialization failed")),
			false,
			`stale-context init should not log a failure; saw: ${JSON.stringify(consoleErrors)}`,
		);
		// The synchronous startup path still registers the proxy gateway tool.
		assert.ok(
			registeredTools.includes("mcp"),
			"session_start should register the MCP proxy tool before the async gap",
		);
	} finally {
		console.error = originalConsoleError;
	}
});
