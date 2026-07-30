/**
 * Ownership of a submission after the transport dies.
 *
 * Output cannot answer it: `touch marker && sleep 400` changes the working tree
 * and prints nothing, so a host that waited for a first chunk classified that
 * command as never sent and offered the `!` text back — inviting a second run of
 * work that had already happened. The child now announces admission for every
 * correlated request before its handler touches anything, and the host restores
 * a draft only for a transport failure that arrived without one.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEngineSendFailure } from "../../packages/coding-agent/src/modes/interactive/interactive-prompt-restore.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import {
	isRpcRequestAcceptedFailure,
	isRpcTransportFailure,
} from "../../packages/coding-agent/src/modes/rpc/rpc-transport-error.ts";

const serialTest = process.platform === "win32" ? test.serial.skip : test.serial;

function makeClient(): RpcClient {
	return new RpcClient({
		cliPath: join(import.meta.dir, "../../packages/coding-agent/src/cli.ts"),
		cwd: join(import.meta.dir, "../.."),
		runtimeExecutable: process.execPath,
		provider: "isolation-fixture",
		model: "blocking-model",
		args: [
			"--no-session", "--no-extensions", "--extension",
			join(import.meta.dir, "fixtures", "blocking-tool-extension.ts"),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve",
		],
		interactiveEngine: { onDiagnostic: () => {} },
	});
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(20);
	}
	throw new Error(`timed out waiting for ${label}`);
}

serialTest("a quiet accepted bash command is not returned as unsent when the engine dies", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-admission-"));
	const marker = join(temp, "side-effect");
	const client = makeClient();
	try {
		await client.start();
		await client.waitForInteractiveEngineBound();
		const enginePid = client.getEnginePid();
		assert.ok(enginePid, "engine child never reported its pid");

		let chunks = 0;
		const pending = client.userBashWithUpdates(`touch ${JSON.stringify(marker)} && sleep 400`, () => { chunks += 1; })
			.then(() => undefined, (error: unknown) => error);

		// The side effect proves the child accepted and ran the command.
		await waitFor(() => existsSync(marker), 15_000, "the bash side effect");
		assert.equal(chunks, 0, "the command must be silent for this test to mean anything");

		process.kill(enginePid, "SIGKILL");
		const error = await pending;

		assert.ok(isRpcTransportFailure(error), "engine death must still be a transport failure");
		assert.ok(isRpcRequestAcceptedFailure(error), "the child had taken the request; admission was lost");
		assert.equal(
			isEngineSendFailure(error),
			false,
			"accepted work must not be offered back to the editor for a second run",
		);
	} finally {
		await client.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 60_000);

serialTest("a send the child never received stays restorable", async () => {
	const client = makeClient();
	try {
		await client.start();
		await client.waitForInteractiveEngineBound();
		// Detach the writer exactly as a dying transport would, before the frame
		// can reach the child: no admission can exist for this request.
		const stopped = client.stop();
		const error = await client.prompt("never delivered").then(() => undefined, (reason: unknown) => reason);
		await stopped;

		assert.ok(isRpcTransportFailure(error));
		assert.equal(isRpcRequestAcceptedFailure(error), false, "an undelivered frame must not look accepted");
		assert.equal(isEngineSendFailure(error), true, "the exact draft must still be restorable");
	} finally {
		await client.stop();
	}
}, 60_000);

serialTest("a queued admission frame is parsed before the exit rejection", async () => {
	// The fixture admits and exits in the same turn, so the frame is still in the
	// pipe when `exit` fires — the ordering a real dying child cannot be made to
	// reproduce on demand.
	const client = new RpcClient({
		cliPath: join(import.meta.dir, "fixtures", "admission-race-engine.ts"),
		cwd: join(import.meta.dir, "../.."),
		runtimeExecutable: process.execPath,
		interactiveEngine: { onDiagnostic: () => {} },
	});
	try {
		await client.start();
		const error = await client.prompt("admit then die").then(() => undefined, (reason: unknown) => reason);
		assert.ok(isRpcTransportFailure(error), "the death is still a transport failure");
		assert.ok(
			isRpcRequestAcceptedFailure(error),
			"the exit rejection outran the queued admission frame",
		);
		assert.equal(isEngineSendFailure(error), false);
	} finally {
		await client.stop();
	}
}, 60_000);
