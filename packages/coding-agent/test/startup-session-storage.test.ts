import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.js";
import { bunExecutable, cliPath } from "./cli-test-helpers.js";

// Runs a real CLI child, trust dialog, settings reload and RPC writes.
const TRUST_STORAGE_RPC_TIMEOUT_MS = 120_000;
for (const storage of [{ memory: true }, { path: "approved.sqlite", prefix: "approved_" }] as const) {
	test(
		`first trust approval selects ${"memory" in storage ? "memory" : "custom SQLite"} before session writes`,
		async () => {
			const root = mkdtempSync(join(tmpdir(), "approved-session-storage-"));
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			mkdirSync(join(cwd, ".atomic"), { recursive: true });
			mkdirSync(agentDir);
			writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ sessions: { storage } }));
			const client = new RpcClient({
				cliPath,
				cwd,
				runtimeExecutable: bunExecutable(),
				args: [
					"--offline",
					"--no-extensions",
					"--no-mcp",
					"--no-skills",
					"--no-themes",
					"--no-prompt-templates",
					"--provider",
					"anthropic",
					"--model",
					"claude-sonnet-4-5",
				],
				env: { ATOMIC_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: "local-no-requests" },
				interactiveEngine: { onDiagnostic: () => {} },
			});
			let show!: (request: RpcExtensionUIRequest) => void;
			const prompt = new Promise<RpcExtensionUIRequest>((resolve) => {
				show = resolve;
			});
			client.onExtensionUIRequest((request) => {
				if (request.method === "select") show(request);
			});
			try {
				await client.start();
				const request = await prompt;
				await client.respondExtensionUI({
					type: "extension_ui_response",
					id: request.id,
					value: "Trust (this session only)",
				});
				await client.waitForInteractiveEngineResources();
				await client.setSessionName("approved write");
				const state = await client.getState();
				const defaultStore = await resolveSessionStore(cwd, { agentDir, settings: {} });
				try {
					assert.equal(await defaultStore.readHeader(state.sessionId), undefined);
				} finally {
					await defaultStore.close();
				}
				if (!("memory" in storage)) {
					const selected = await resolveSessionStore(cwd, { agentDir, settings: { sessions: { storage } } });
					try {
						const snapshot = await selected.load(state.sessionId);
						const last = snapshot.entries.at(-1);
						assert.equal(last?.type, "session_info");
						if (last?.type === "session_info") assert.equal(last.name, "approved write");
					} finally {
						await selected.close();
					}
				}
			} finally {
				await client.stop();
				rmSync(root, { recursive: true, force: true });
			}
		},
		TRUST_STORAGE_RPC_TIMEOUT_MS,
	);
}
