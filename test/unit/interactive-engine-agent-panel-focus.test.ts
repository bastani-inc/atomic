import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { InteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

const REAL_ENGINE_TEST_TIMEOUT_MS = 90_000;

function createClient(agentDir: string): RpcClient {
	return new RpcClient({
		cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
		cwd: join(moduleDir(import.meta.url), "../.."),
		runtimeExecutable: bunExecutable(),
		provider: "isolation-fixture",
		model: "blocking-model",
		env: { ATOMIC_CODING_AGENT_DIR: agentDir },
		args: [
			"--no-session",
			"--no-extensions",
			"--extension",
			join(moduleDir(import.meta.url), "fixtures", "agent-panel-row-extension.ts"),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
			"--approve",
		],
		interactiveEngine: { onDiagnostic: () => {} },
	});
}

async function waitFor(probe: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!probe()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(20);
	}
}

test(
	"rapid focus requests to the engine open one agent panel, and it opens again once closed (#5224)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-agent-panel-focus-"));
		const client = createClient(join(dir, "agent"));
		const opened: string[] = [];
		const done: string[] = [];
		client.onInteractiveEngineMessage((message: InteractiveEngineMessage) => {
			if (message.type === "engine_custom_open" && message.purpose === "navigation")
				opened.push(message.componentId);
			if (message.type === "engine_custom_done") done.push(message.componentId);
		});
		try {
			await client.start();
			await Promise.all([
				client.requestInternal({ type: "open_agent_panel" }),
				client.requestInternal({ type: "open_agent_panel" }),
				client.requestInternal({ type: "open_agent_panel" }),
			]);
			await waitFor(() => opened.length > 0, "the focused agent panel");
			await sleep(750);
			assert.equal(opened.length, 1);

			const panel = opened[0]!;
			client.sendInteractiveEngineCommand({
				type: "engine_custom_input",
				componentId: panel,
				requestId: 1,
				data: "\x1b",
			});
			await waitFor(() => done.includes(panel), "the panel to close");
			await client.requestInternal({ type: "open_agent_panel" });
			await waitFor(() => opened.length === 2, "the panel to open again");
		} finally {
			await client.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_ENGINE_TEST_TIMEOUT_MS,
);
