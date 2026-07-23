import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { AgentSessionReloadOptions } from "../../packages/coding-agent/src/core/agent-session-types.ts";
import { KeybindingsReloadCoordinator, reloadSessionWithKeybindings } from "../../packages/coding-agent/src/modes/rpc/rpc-keybindings-reload.ts";

function writeExpandBinding(agentDir: string, binding: string): void {
	writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.tools.expand": binding }));
}

describe("RPC effective-keybinding reload transaction", () => {
	test("applies the new state before session_start and notifies after reload succeeds", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-rpc-keybinding-order-"));
		try {
			writeExpandBinding(tempDir, "ctrl+x");
			const keybindings = KeybindingsManager.create(tempDir);
			const identity = keybindings;
			writeExpandBinding(tempDir, "ctrl+y");
			const phases: string[] = [];
			const session = {
				async reload(options?: AgentSessionReloadOptions): Promise<void> {
					phases.push(`before:${keybindings.getKeys("app.tools.expand").join("/")}`);
					await options?.beforeSessionStart?.();
					phases.push(`session_start:${keybindings.getKeys("app.tools.expand").join("/")}`);
				},
			};

			await reloadSessionWithKeybindings(session, keybindings, () => phases.push("notified"));

			assert.equal(keybindings, identity);
			assert.deepEqual(phases, ["before:ctrl+x", "session_start:ctrl+y", "notified"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("rolls back in place and does not notify when session reload fails after staging", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-rpc-keybinding-rollback-"));
		try {
			writeExpandBinding(tempDir, "ctrl+x");
			const keybindings = KeybindingsManager.create(tempDir);
			const identity = keybindings;
			writeExpandBinding(tempDir, "ctrl+y");
			let notifications = 0;
			const session = {
				async reload(options?: AgentSessionReloadOptions): Promise<void> {
					await options?.beforeSessionStart?.();
					assert.deepEqual(keybindings.getKeys("app.tools.expand"), ["ctrl+y"]);
					throw new Error("reload failed after runtime rebuild");
				},
			};

			await assert.rejects(
				reloadSessionWithKeybindings(session, keybindings, () => { notifications++; }),
				/reload failed after runtime rebuild/,
			);
			assert.equal(keybindings, identity);
			assert.deepEqual(keybindings.getKeys("app.tools.expand"), ["ctrl+x"]);
			assert.equal(notifications, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});


	test("serializes overlapping success/failure transactions without rolling back the committed state", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-rpc-keybinding-overlap-"));
		try {
			writeExpandBinding(tempDir, "ctrl+x");
			const keybindings = KeybindingsManager.create(tempDir);
			const releases: Array<() => void> = [];
			const entered: Array<() => void> = [];
			const enteredPromises = [0, 1].map((index) => new Promise<void>((resolve) => { entered[index] = resolve; }));
			const notifications: string[] = [];
			let call = 0;
			const session = {
				async reload(options?: AgentSessionReloadOptions): Promise<void> {
					const index = call++;
					entered[index]?.();
					await new Promise<void>((resolve) => { releases[index] = resolve; });
					writeExpandBinding(tempDir, index === 0 ? "ctrl+y" : "ctrl+z");
					await options?.beforeSessionStart?.();
					if (index === 1) throw new Error("second reload failed");
				},
			};
			const coordinator = new KeybindingsReloadCoordinator(keybindings, (state) => {
				notifications.push(String(state.userBindings["app.tools.expand"]));
			});

			const first = coordinator.reload(session);
			await enteredPromises[0];
			const second = coordinator.reload(session);
			await Bun.sleep(0);
			assert.equal(call, 1, "second transaction must not enter while first is pending");
			releases[0]?.();
			await first;
			await enteredPromises[1];
			releases[1]?.();
			await assert.rejects(second, /second reload failed/);

			assert.deepEqual(keybindings.getKeys("app.tools.expand"), ["ctrl+y"]);
			assert.deepEqual(notifications, ["ctrl+y"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("continues after rejection and emits one state for each duplicate sequential success", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-rpc-keybinding-queue-continuation-"));
		try {
			writeExpandBinding(tempDir, "ctrl+x");
			const keybindings = KeybindingsManager.create(tempDir);
			const notifications: string[] = [];
			let call = 0;
			const session = {
				async reload(options?: AgentSessionReloadOptions): Promise<void> {
					call++;
					await options?.beforeSessionStart?.();
					if (call === 1) throw new Error("first rejected");
				},
			};
			const coordinator = new KeybindingsReloadCoordinator(keybindings, (state) => {
				notifications.push(String(state.userBindings["app.tools.expand"]));
			});
			writeExpandBinding(tempDir, "ctrl+y");
			await assert.rejects(coordinator.reload(session), /first rejected/);
			await coordinator.reload(session);
			await coordinator.reload(session);
			assert.equal(call, 3);
			assert.deepEqual(notifications, ["ctrl+y", "ctrl+y"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("preserves generic headless reload behavior when no UI manager exists", async () => {
		let calls = 0;
		const session = {
			async reload(options?: AgentSessionReloadOptions): Promise<void> {
				calls++;
				assert.equal(options, undefined);
			},
		};
		await reloadSessionWithKeybindings(session, undefined, () => assert.fail("must not notify"));
		assert.equal(calls, 1);
	});
});
