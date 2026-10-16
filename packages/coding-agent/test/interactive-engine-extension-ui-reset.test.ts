import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { EngineDialogHostController } from "../src/modes/interactive-engine/engine-dialog-host.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An engine child whose session replacement behaves like the real one: it retires the old session
 * (`engine_extension_ui_reset`), binds the new one, whose `session_start` sets a widget, and only then
 * answers the request. All of it goes through one stdout stream, in that order.
 */
function writeEngineScript(sessionFile: string, sessionId: string): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-engine-ui-reset-"));
	tempDirs.push(dir);
	const path = join(dir, "engine.mjs");
	writeFileSync(
		path,
		`import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
send({ type: "engine_ready", protocolVersion: 4, pid: process.pid });
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	const respond = (data) => send({ type: "response", id: command.id, command: command.type, success: true, data });
	switch (command.type) {
		case "engine_explicit_quit":
			send({ type: "engine_explicit_quit_ack" });
			break;
		case "get_state":
			respond({
				thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all",
				sessionLocation: ${JSON.stringify(sessionFile)}, sessionId: ${JSON.stringify(sessionId)}, autoCompactionEnabled: true,
				messageCount: 0, pendingMessageCount: 0, queuedMessagesPaused: false,
			});
			break;
		case "get_available_models":
			respond({ models: [], scopedModels: [] });
			break;
		case "get_commands":
			respond({ commands: [] });
			break;
		case "switch_session":
		case "new_session":
		case "fork":
			send({ type: "engine_extension_ui_reset" });
			send({ type: "extension_ui_request", id: "ui-1", method: "setWidget", widgetKey: "issue-3561", widgetLines: ["new session"] });
			respond({ cancelled: false, text: "" });
			break;
	}
});
process.stdin.resume();
`,
	);
	return path;
}

/** A host over a real RpcClient and an engine child, with the mode's extension UI stood in by a widget map. */
async function startHost() {
	const dir = mkdtempSync(join(tmpdir(), "atomic-isolated-host-"));
	tempDirs.push(dir);
	const targetManager = await SessionManager.create(dir, dir);

	const targetSessionFile = targetManager.getSessionFile();
	if (!targetSessionFile) throw new Error("Missing target session file");
	const first = await createHarness({
		sessionManager: await SessionManager.create(targetManager.getSessionStore(), dir),
	});
	const second = await createHarness({ sessionManager: targetManager });
	cleanups.push(
		() => first.cleanup(),
		() => second.cleanup(),
	);
	const servicesFor = (harness: Harness) => ({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
	});

	const client = new RpcClient({
		cliPath: writeEngineScript(targetSessionFile, targetManager.getSessionId()),
		interactiveEngine: { onDiagnostic: () => {} },
	});
	await client.start();
	cleanups.push(() => client.stop());
	const localRuntime = new AgentSessionRuntime(first.session, servicesFor(first) as never, async () => {
		throw new Error("unused local runtime factory");
	});
	const runtime = new IsolatedInteractiveRuntime(
		localRuntime,
		async () => ({ session: second.session, services: servicesFor(second), diagnostics: [] }) as never,
		client,
	);

	const log: string[] = [];
	const widgets = new Map<string, readonly string[]>();
	const ui = {
		setWidget: (key: string, content: readonly string[] | undefined) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
			log.push(`${content === undefined ? "clearWidget" : "setWidget"}:${key}`);
		},
	} as unknown as ExtensionUIContext;
	const dialogs = new EngineDialogHostController(runtime, ui);
	cleanups.push(() => dialogs.dispose());
	// The interactive mode registers its resetExtensionUI exactly like this.
	runtime.setBeforeSessionInvalidate(() => {
		log.push("resetExtensionUI");
		widgets.clear();
	});
	return { runtime, log, widgets, targetSessionId: targetManager.getSessionId() };
}

describe("isolated interactive extension UI reset", () => {
	test.each([
		["resume", (runtime: IsolatedInteractiveRuntime, sessionId: string) => runtime.switchSession(sessionId)],
		["new", (runtime: IsolatedInteractiveRuntime) => runtime.newSession()],
		["fork", (runtime: IsolatedInteractiveRuntime) => runtime.fork("entry")],
	])(
		"keeps the widget the engine's new session sets on %s and resets the old UI once, before it (#3561)",
		async (_reason, replace) => {
			const { runtime, log, widgets, targetSessionId } = await startHost();

			await replace(runtime, targetSessionId);

			// The engine retired the old session before it bound the new one; the host's later mirror
			// teardown of its own session must not reset again, which would clear the new widget.
			assert.deepEqual(log, ["resetExtensionUI", "setWidget:issue-3561"]);
			assert.deepEqual([...widgets], [["issue-3561", ["new session"]]]);
		},
	);

	test("still resets the extension UI when the host quits (#3561)", async () => {
		const { runtime, log, widgets, targetSessionId } = await startHost();
		await runtime.switchSession(targetSessionId);
		log.length = 0;

		await runtime.dispose();

		assert.equal(log.filter((entry) => entry === "resetExtensionUI").length, 1);
		assert.equal(widgets.size, 0);
	});
});
