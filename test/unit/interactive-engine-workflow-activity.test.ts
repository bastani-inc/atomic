import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import type { WorkflowActivityFrame } from "../../packages/coding-agent/src/core/extensions/workflow-events.ts";
import { attachInteractiveEngineHost } from "../../packages/coding-agent/src/modes/interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

/**
 * The engine child publishes its workflow snapshot as soon as it binds, while the host attaches its
 * observer only after its own startup awaits (first-time setup, the deprecation-warning keypress wait).
 * Both tests run against a real engine child so the frame crosses the real wire before the observer exists.
 */

const SNAPSHOT_PUBLISHED_CAP_MS = 15_000;
const ENGINE_DEATH_CAP_MS = 5_000;
const ENGINE_DEATH_POLL_MS = 10;
const REAL_ENGINE_TEST_TIMEOUT_MS = 60_000;

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
			join(moduleDir(import.meta.url), "fixtures", "blocking-tool-extension.ts"),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--offline",
			"--approve",
		],
		interactiveEngine: { onDiagnostic: () => {} },
	});
}

/** Resolves once the engine's workflow activity crossed the wire, with no host observer attached yet. */
function workflowActivityPublished(client: RpcClient): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			stopTap();
			reject(new Error(`the engine published no workflow activity within ${SNAPSHOT_PUBLISHED_CAP_MS} ms`));
		}, SNAPSHOT_PUBLISHED_CAP_MS);
		const stopTap = client.onInteractiveEngineMessage((message) => {
			if (message.type !== "engine_workflow_activity") return;
			clearTimeout(timer);
			stopTap();
			resolve();
		});
	});
}

async function waitForRetainedGenerationEnd(client: RpcClient): Promise<void> {
	const deadline = Date.now() + ENGINE_DEATH_CAP_MS;
	while (Date.now() < deadline) {
		let ended = false;
		client.onGenerationEnded(() => {
			ended = true;
		})();
		if (ended) return;
		await sleep(ENGINE_DEATH_POLL_MS);
	}
	throw new Error(`the engine's death was not observed within ${ENGINE_DEATH_CAP_MS} ms`);
}

function attachHost(client: RpcClient, observed: WorkflowActivityFrame[]): () => void {
	return attachInteractiveEngineHost(
		hostRuntimeOver(client),
		{ setWidget: () => {}, requestRender: () => {}, custom: async () => undefined } as unknown as ExtensionUIContext,
		() => {},
		{ isFullscreen: () => false, onRendererReplaced: () => () => {} },
		undefined,
		undefined,
		(frame) => observed.push(frame),
	);
}

function hostRuntimeOver(client: RpcClient): AgentSessionRuntime {
	return Object.assign(Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime, {
		onDiagnostic: () => () => {},
		setExtensionUIHandler: () => () => {},
		onGenerationEnded: (listener: Parameters<RpcClient["onGenerationEnded"]>[0]) =>
			client.onGenerationEnded(listener),
		onEngineMessage: (listener: Parameters<RpcClient["onInteractiveEngineMessage"]>[0]) =>
			client.onInteractiveEngineMessage(listener),
		onWorkflowActivity: (listener: (frame: WorkflowActivityFrame) => void) =>
			client.onInteractiveEngineWorkflowActivity(listener),
		onKeybindingState: () => () => {},
		invokeRemoteShortcut: async () => {},
		sendEngineCommand: () => {},
	}) as unknown as AgentSessionRuntime;
}

test.sequential(
	"a host attached after the engine published its workflow snapshot starts from the current one (#3556)",
	async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-workflow-activity-"));
		const client = createClient(tempDir);
		try {
			const published = workflowActivityPublished(client);
			await client.start();
			await published;
			const observed: WorkflowActivityFrame[] = [];
			const detach = attachHost(client, observed);
			assert.equal(observed.length, 1, "the late host is handed exactly one snapshot on attach");
			assert.equal(observed[0]?.kind, "snapshot");
			detach();
		} finally {
			await client.stop();
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
	REAL_ENGINE_TEST_TIMEOUT_MS,
);

test.sequential(
	"a dead engine generation's workflow activity is not replayed to a late host (#3556)",
	async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-workflow-activity-"));
		const client = createClient(tempDir);
		try {
			const published = workflowActivityPublished(client);
			await client.start();
			await published;
			const pid = client.getEnginePid();
			assert.ok(pid !== undefined, "the engine child reported its pid");
			process.kill(pid, "SIGKILL");
			await waitForRetainedGenerationEnd(client);
			const observed: WorkflowActivityFrame[] = [];
			const detach = attachHost(client, observed);
			assert.deepEqual(
				observed.map((frame) => frame.kind === "snapshot" && frame.availability),
				["unavailable"],
				"a late host learns the engine is gone, so a stale working cannot stick",
			);
			detach();
		} finally {
			await client.stop();
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
	REAL_ENGINE_TEST_TIMEOUT_MS,
);
