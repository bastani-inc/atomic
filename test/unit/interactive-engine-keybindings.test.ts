import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { formatKeyText } from "../../packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { type Terminal, TUI } from "@earendil-works/pi-tui";
import { parseInteractiveEngineMessage, type InteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { attachInteractiveEngineKeybindingSync } from "../../packages/coding-agent/src/modes/interactive-engine/extension-ui-bridge.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

function createClient(agentDir: string, env: Record<string, string> = {}): RpcClient {
	return new RpcClient({
		cliPath: join(import.meta.dir, "../../packages/coding-agent/src/cli.ts"),
		cwd: join(import.meta.dir, "../.."),
		runtimeExecutable: process.execPath,
		provider: "isolation-fixture",
		model: "blocking-model",
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, ...env },
		args: [
			"--no-session", "--no-extensions", "--extension",
			join(import.meta.dir, "fixtures", "blocking-tool-extension.ts"),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve",
		],
		interactiveEngine: { onDiagnostic: () => {} },
	});
}

function nextMessage<T extends InteractiveEngineMessage["type"]>(
	client: RpcClient,
	type: T,
	predicate: (message: Extract<InteractiveEngineMessage, { type: T }>) => boolean,
): Promise<Extract<InteractiveEngineMessage, { type: T }>> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		const timeout = setTimeout(() => {
			unsubscribe?.();
			reject(new Error(`Timed out waiting for ${type}`));
		}, 5_000);
		const registered = client.onInteractiveEngineMessage((message) => {
			if (settled || message.type !== type) return;
			const typed = message as Extract<InteractiveEngineMessage, { type: T }>;
			if (!predicate(typed)) return;
			settled = true;
			clearTimeout(timeout);
			unsubscribe?.();
			resolve(typed);
		});
		unsubscribe = registered;
		if (settled) registered();
	});
}

function nextKeybindingsReload(
	client: RpcClient,
): Promise<Extract<InteractiveEngineMessage, { type: "engine_keybindings_reloaded" }>> {
	return nextMessage(client, "engine_keybindings_reloaded", () => true);
}

function readSessionStartBindings(path: string): string[] {
	return readFileSync(path, "utf8").trim().split("\n");
}

function nextFrame(client: RpcClient, componentId: string, requestId: number) {
	return nextMessage(client, "engine_custom_frame", (message) =>
		message.componentId === componentId && message.requestId === requestId,
	);
}

async function renderSkill(client: RpcClient, expanded: boolean, requestId: number): Promise<string> {
	const componentId = `skill-${requestId}`;
	const frame = nextFrame(client, componentId, requestId);
	client.sendInteractiveEngineCommand({
		type: "engine_tool_render",
		componentId,
		requestId,
		width: 120,
		toolName: "read",
		toolCallId: `read-${requestId}`,
		args: { path: join(process.cwd(), "tmux", "SKILL.md") },
		result: {
			content: [{ type: "text", text: "# Tmux skill instructions" }],
			details: {},
			isError: false,
		},
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		imageWidthCells: 80,
	});
	return stripAnsi((await frame).lines.join("\n"));
}

async function renderCustom(client: RpcClient, componentId: string, requestId: number): Promise<string> {
	const frame = nextFrame(client, componentId, requestId);
	client.sendInteractiveEngineCommand({
		type: "engine_custom_render",
		componentId,
		requestId,
		width: 120,
		rows: 40,
	});
	return stripAnsi((await frame).lines.join("\n"));
}

function writeExpandBinding(agentDir: string, binding: string | string[]): void {
	writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.tools.expand": binding }));
}


test("host applies the committed engine payload without rereading a later filesystem value", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-keybinding-payload-"));
	try {
		writeExpandBinding(tempDir, "ctrl+x");
		const hostKeybindings = KeybindingsManager.create(tempDir);
		let listener: ((message: InteractiveEngineMessage) => void) | undefined;
		attachInteractiveEngineKeybindingSync({
			onEngineMessage: (next) => { listener = next; return () => {}; },
		}, hostKeybindings);
		const committed = {
			type: "engine_keybindings_reloaded",
			state: {
				userBindings: { "app.tools.expand": "ctrl+y" },
				effectiveBindings: { "app.tools.expand": "ctrl+y" },
				shortcuts: [],
			},
		} as unknown as InteractiveEngineMessage;
		writeExpandBinding(tempDir, "ctrl+z");
		listener?.(committed);
		assert.deepEqual(hostKeybindings.getKeys("app.tools.expand"), ["ctrl+y"]);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});


test("keybinding state protocol preserves raw ordered arrays", () => {
	const message = parseInteractiveEngineMessage(JSON.stringify({
		type: "engine_keybindings_reloaded",
		state: {
			userBindings: { "app.tools.expand": ["", "ctrl+x", ""] },
			effectiveBindings: { "app.tools.expand": ["", "ctrl+x", ""] },
			shortcuts: [{ key: "ctrl+y", description: "fixture" }],
		},
	}));
	assert.equal(message?.type, "engine_keybindings_reloaded");
	if (message?.type !== "engine_keybindings_reloaded") return;
	assert.deepEqual(message.state.userBindings["app.tools.expand"], ["", "ctrl+x", ""]);
	assert.deepEqual(message.state.effectiveBindings["app.tools.expand"], ["", "ctrl+x", ""]);
	assert.deepEqual(message.state.shortcuts, [{ key: "ctrl+y", description: "fixture" }]);
});

test.serial("late host attachment receives the latest committed child state", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-keybindings-late-attach-"));
	writeExpandBinding(tempDir, "ctrl+x");
	const client = createClient(tempDir);
	const hostKeybindings = KeybindingsManager.create(tempDir);
	try {
		await client.start();
		await client.waitForInteractiveEngineBound();
		writeExpandBinding(tempDir, "ctrl+y");
		await client.requestInternal<void>({ type: "reload" });
		const detach = attachInteractiveEngineKeybindingSync({
			onEngineMessage: (listener) => client.onInteractiveEngineMessage(listener),
			onKeybindingState: (listener) => client.onInteractiveEngineKeybindingState(listener),
		}, hostKeybindings);
		assert.deepEqual(hostKeybindings.getKeys("app.tools.expand"), ["ctrl+y"]);
		detach();
	} finally {
		await client.stop();
		rmSync(tempDir, { recursive: true, force: true });
	}
});


test.serial("isolated child renders Atomic's default expand key on collapsed skill reads", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-keybindings-"));
	const client = createClient(tempDir);
	try {
		await client.start();
		await client.waitForInteractiveEngineBound();
		const rendered = await renderSkill(client, false, 1);
		assert.match(rendered, /\[skill\] tmux \(ctrl\+o Expand\)/);
		assert.doesNotMatch(rendered, /\[skill\] tmux \( Expand\)/);
	} finally {
		await client.stop();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test.serial("isolated child renders the host-effective custom expand key and preserves expansion", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-keybindings-remap-"));
	writeExpandBinding(tempDir, "ctrl+x");
	const hostKeybindings = KeybindingsManager.create(tempDir);
	const hostText = formatKeyText(hostKeybindings.getKeys("app.tools.expand").join("/"));
	const client = createClient(tempDir);
	try {
		await client.start();
		await client.waitForInteractiveEngineBound();
		const collapsed = await renderSkill(client, false, 2);
		assert.equal(hostText, "ctrl+x");
		assert.ok(collapsed.includes(`[skill] tmux (${hostText} Expand)`));
		assert.doesNotMatch(collapsed, /ctrl\+o Expand|\( Expand\)/);

		const expanded = await renderSkill(client, true, 3);
		assert.match(expanded, /Tmux skill instructions/);
		assert.doesNotMatch(expanded, /\[skill\] tmux/);
	} finally {
		await client.stop();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test.serial("direct RPC reload updates one shared global and injected manager in place", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-keybindings-reload-"));
	writeExpandBinding(tempDir, "ctrl+x");
	const sessionStartFile = join(tempDir, "session-start-bindings.txt");
	const client = createClient(tempDir, {
		ATOMIC_KEYBINDINGS_CUSTOM_UI: "1",
		ATOMIC_KEYBINDINGS_SESSION_START_FILE: sessionStartFile,
	});
	const hostKeybindings = KeybindingsManager.create(tempDir);
	const hostIdentity = hostKeybindings;
	const detachHostSync = attachInteractiveEngineKeybindingSync({
		onEngineMessage: (listener) => client.onInteractiveEngineMessage(listener),
	}, hostKeybindings);
	try {
		const opened = nextMessage(client, "engine_custom_open", (message) => message.componentId.startsWith("remote_component_"));
		await client.start();
		await client.waitForInteractiveEngineBound();
		const open = await opened;
		assert.equal(await renderCustom(client, open.componentId, 10), "same:true|injected:ctrl+x|global:ctrl+x");
		assert.match(await renderSkill(client, false, 11), /\(ctrl\+x Expand\)/);

		writeExpandBinding(tempDir, "ctrl+y");
		const reloaded = nextKeybindingsReload(client);
		await client.requestInternal<void>({ type: "reload" });
		assert.deepEqual(readSessionStartBindings(sessionStartFile), ["startup:ctrl+x", "reload:ctrl+y"]);
		const committed = await reloaded;
		assert.equal(committed.state.userBindings["app.tools.expand"], "ctrl+y");
		assert.equal(committed.state.effectiveBindings["app.tools.expand"], "ctrl+y");
		assert.deepEqual(committed.state.shortcuts, []);
		assert.equal(hostKeybindings, hostIdentity);
		assert.deepEqual(hostKeybindings.getKeys("app.tools.expand"), ["ctrl+y"]);
		hostKeybindings.reload(); // Host /reload repeats this after the child notification.
		assert.equal(hostKeybindings, hostIdentity);
		assert.deepEqual(hostKeybindings.getKeys("app.tools.expand"), ["ctrl+y"]);
		assert.equal(await renderCustom(client, open.componentId, 12), "same:true|injected:ctrl+y|global:ctrl+y");
		assert.match(await renderSkill(client, false, 13), /\(ctrl\+y Expand\)/);

		writeExpandBinding(tempDir, []);
		const unboundReloaded = nextKeybindingsReload(client);
		await client.requestInternal<void>({ type: "reload" });
		await unboundReloaded;
		assert.deepEqual(hostKeybindings.getKeys("app.tools.expand"), []);
		assert.equal(await renderCustom(client, open.componentId, 14), "same:true|injected:|global:");
		const unbound = await renderSkill(client, false, 15);
		assert.match(unbound, /\[skill\] tmux/);
		assert.doesNotMatch(unbound, /Expand|\(\s*\)/);
	} finally {
		detachHostSync();
		await client.stop();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test.serial("extension command-context reload updates the existing shared manager", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-engine-keybindings-context-reload-"));
	writeExpandBinding(tempDir, "ctrl+x");
	const sessionStartFile = join(tempDir, "session-start-bindings.txt");
	const client = createClient(tempDir, {
		ATOMIC_KEYBINDINGS_CUSTOM_UI: "1",
		ATOMIC_KEYBINDINGS_RELOAD_COMMAND: "1",
		ATOMIC_KEYBINDINGS_SESSION_START_FILE: sessionStartFile,
	});
	const hostKeybindings = KeybindingsManager.create(tempDir);
	const hostIdentity = hostKeybindings;
	initTheme("dark");
	const editor = new CustomEditor(new TUI(new FakeTerminal()), getEditorTheme(), hostKeybindings);
	let expandDispatches = 0;
	editor.onAction("app.tools.expand", () => { expandDispatches++; });
	const detachHostSync = attachInteractiveEngineKeybindingSync({
		onEngineMessage: (listener) => client.onInteractiveEngineMessage(listener),
	}, hostKeybindings);
	try {
		const opened = nextMessage(client, "engine_custom_open", (message) => message.componentId.startsWith("remote_component_"));
		await client.start();
		await client.waitForInteractiveEngineBound();
		const open = await opened;
		assert.equal(await renderCustom(client, open.componentId, 20), "same:true|injected:ctrl+x|global:ctrl+x");
		editor.handleInput("\x18");
		assert.equal(expandDispatches, 1);

		writeExpandBinding(tempDir, "ctrl+y");
		const reloaded = nextKeybindingsReload(client);
		await client.prompt("/reload-keybindings-fixture");
		await reloaded;
		assert.deepEqual(readSessionStartBindings(sessionStartFile), ["startup:ctrl+x", "reload:ctrl+y"]);
		assert.equal(hostKeybindings, hostIdentity);
		editor.handleInput("\x18");
		assert.equal(expandDispatches, 1, "old host remap must stop dispatching");
		editor.handleInput("\x19");
		assert.equal(expandDispatches, 2, "new host remap must dispatch");
		assert.equal(await renderCustom(client, open.componentId, 21), "same:true|injected:ctrl+y|global:ctrl+y");
		assert.match(await renderSkill(client, false, 22), /\(ctrl\+y Expand\)/);

		writeExpandBinding(tempDir, []);
		const unboundReloaded = nextKeybindingsReload(client);
		await client.prompt("/reload-keybindings-fixture");
		await unboundReloaded;
		editor.handleInput("\x19");
		assert.equal(expandDispatches, 2, "unbound host action must not dispatch the old remap");
	} finally {
		detachHostSync();
		await client.stop();
		rmSync(tempDir, { recursive: true, force: true });
	}
}, 15_000);
