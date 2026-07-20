import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ExtensionShortcut } from "../../packages/coding-agent/src/core/extensions/index.ts";
import type { KeybindingsConfig } from "../../packages/coding-agent/src/core/keybindings.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";

function writeExpandBinding(agentDir: string, binding: string): void {
	writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.tools.expand": binding }));
}

test.serial("headless shortcut RPC uses one fallback manager from services.agentDir", async () => {
	const serviceAgentDir = mkdtempSync(join(tmpdir(), "atomic-rpc-service-agent-dir-"));
	const ambientAgentDir = mkdtempSync(join(tmpdir(), "atomic-rpc-ambient-agent-dir-"));
	const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	const invoked: string[] = [];
	try {
		writeExpandBinding(serviceAgentDir, "ctrl+x");
		writeExpandBinding(ambientAgentDir, "ctrl+y");
		process.env.ATOMIC_CODING_AGENT_DIR = ambientAgentDir;
		const shortcuts = new Map<KeyId, ExtensionShortcut>([
			["ctrl+x" as KeyId, {
				shortcut: "ctrl+x" as KeyId,
				description: "x shortcut",
				extensionPath: "fixture.ts",
				handler: () => { invoked.push("ctrl+x"); },
			}],
			["ctrl+y" as KeyId, {
				shortcut: "ctrl+y" as KeyId,
				description: "y shortcut",
				extensionPath: "fixture.ts",
				handler: () => { invoked.push("ctrl+y"); },
			}],
		]);
		const getShortcuts = (bindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> => {
			const configured = bindings["app.tools.expand"];
			const reserved = new Set(Array.isArray(configured) ? configured : configured === undefined ? [] : [configured]);
			return new Map([...shortcuts].filter(([key]) => !reserved.has(key)));
		};
		const session = {
			extensionRunner: {
				getShortcuts,
				createContext: () => ({}),
			},
		} as unknown as AgentSession;
		const runtimeHost = {
			services: { agentDir: serviceAgentDir },
		} as unknown as AgentSessionRuntime;
		const handle = createRpcCommandHandler({
			runtimeHost,
			getSession: () => session,
			rebindSession: async () => {},
			output: () => {},
		});

		const listed = await handle({ id: "list", type: "get_shortcuts" });
		assert.ok(listed?.success);
		assert.deepEqual("data" in listed ? listed.data : undefined, {
			shortcuts: [{ key: "ctrl+y", description: "y shortcut" }],
		});
		const invokedResponse = await handle({ id: "invoke", type: "invoke_shortcut", key: "ctrl+y" });
		assert.equal(invokedResponse?.success, true);
		assert.deepEqual(invoked, ["ctrl+y"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
		rmSync(serviceAgentDir, { recursive: true, force: true });
		rmSync(ambientAgentDir, { recursive: true, force: true });
	}
});
