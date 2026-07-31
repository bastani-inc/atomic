/**
 * The bundled MCP panels bind Ctrl+C for their own cancel and cleanup, so they
 * must declare `handlesCtrlC` when they mount.
 *
 * In an isolated interactive session the host closes an undeclared remote
 * `ctx.ui.custom()` component on the first Ctrl+C, which would bypass the
 * panel's own handler — its inactivity timers would not be cleared and its
 * cancelled result would never be built. These tests mount the real panels
 * through the real command entry points and assert both halves: the declaration
 * on the mount options, and the panel behavior the declaration protects.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { openMcpAuthPanel, openMcpPanel, openMcpSetup } from "../../packages/mcp/commands.ts";
import { sleep } from "../helpers/runtime.js";

const CTRL_C = "\x03";

/**
 * The mount happens on the panel's own async path, so a fixed sleep races the
 * event loop under full-suite load. Poll until the mount lands; the deadline
 * only bounds a genuinely broken panel.
 */
const MOUNT_DEADLINE_MS = 5_000;

async function waitForMount(mounts: MountedPanel[]): Promise<void> {
	const deadline = performance.now() + MOUNT_DEADLINE_MS;
	while (mounts.length === 0 && performance.now() < deadline) await sleep(10);
}

interface MountedPanel {
	options: { overlay?: boolean; handlesCtrlC?: boolean } | undefined;
	sendCtrlC(): void;
}

interface Harness {
	mounts: MountedPanel[];
	run: Promise<unknown>;
	cleanup(): void;
}

type CustomFactory = (
	tui: { requestRender(): void },
	theme: unknown,
	keybindings: unknown,
	done: (result: unknown) => void,
) => { handleInput(data: string): void; dispose?(): void };

function harness(
	open: (state: never, pi: never, ctx: never) => Promise<unknown>,
	servers: Record<string, { command: string; args: string[] }>,
): Harness {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-mcp-ctrlc-"));
	const mounts: MountedPanel[] = [];
	const ui = {
		custom: (factory: CustomFactory, options: MountedPanel["options"]) => {
			const component = factory({ requestRender: () => {} }, {}, {}, () => {});
			mounts.push({ options, sendCtrlC: () => component.handleInput(CTRL_C) });
			return new Promise(() => {});
		},
		notify: () => {},
	};
	const state = {
		config: { mcpServers: servers },
		manager: { getConnection: () => undefined, getConnectionStatus: () => undefined },
		failureTracker: new Map<string, number>(),
	};
	const pi = { getFlag: () => undefined };
	const ctx = { cwd, hasUI: true, ui };
	const run = open(state as never, pi as never, ctx as never);
	return { mounts, run, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const OAUTH_SERVER = { command: "npx", args: ["-y", "@example/oauth-server"], url: "https://example.test/mcp" };
const PLAIN_SERVER = { command: "npx", args: ["-y", "@example/server"] };

test("the /mcp panel declares handlesCtrlC and its own Ctrl+C still cancels it", async () => {
	const h = harness(openMcpPanel, { example: PLAIN_SERVER });
	await waitForMount(h.mounts);
	try {
		assert.equal(h.mounts.length, 1, "the panel did not mount");
		assert.equal(h.mounts[0]!.options?.handlesCtrlC, true, "an undeclared panel loses its Ctrl+C to the host");
		assert.equal(h.mounts[0]!.options?.overlay, true);
		// The declaration is only correct because the panel really consumes the key.
		h.mounts[0]!.sendCtrlC();
		await h.run;
	} finally {
		h.cleanup();
	}
});

test("the MCP OAuth panel declares handlesCtrlC and its own Ctrl+C still cancels it", async () => {
	const h = harness(openMcpAuthPanel, { oauth: OAUTH_SERVER as never });
	await waitForMount(h.mounts);
	try {
		assert.equal(h.mounts.length, 1, "the OAuth panel did not mount");
		assert.equal(h.mounts[0]!.options?.handlesCtrlC, true);
		h.mounts[0]!.sendCtrlC();
		await h.run;
	} finally {
		h.cleanup();
	}
});

test("the /mcp setup panel declares handlesCtrlC and its own Ctrl+C still closes it", async () => {
	const h = harness(openMcpSetup, {});
	await waitForMount(h.mounts);
	try {
		assert.equal(h.mounts.length, 1, "the setup panel did not mount");
		assert.equal(h.mounts[0]!.options?.handlesCtrlC, true);
		h.mounts[0]!.sendCtrlC();
		await h.run;
	} finally {
		h.cleanup();
	}
});
