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

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { isEngineSendFailure } from "../../packages/coding-agent/src/modes/interactive/interactive-prompt-restore.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import {
	isRpcRequestAcceptedFailure,
	isRpcTransportFailure,
} from "../../packages/coding-agent/src/modes/rpc/rpc-transport-error.ts";
import { bunExecutable, moduleDir, sleep } from "../helpers/runtime.js";

const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;

function makeClient(): RpcClient {
	return new RpcClient({
		cliPath: join(moduleDir(import.meta.url), "../../packages/coding-agent/src/cli.ts"),
		cwd: join(moduleDir(import.meta.url), "../.."),
		runtimeExecutable: bunExecutable(),
		provider: "isolation-fixture",
		model: "blocking-model",
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

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${label}`);
}

serialTest(
	"a quiet accepted bash command is not returned as unsent when the engine dies",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-admission-"));
		const marker = join(temp, "side-effect");
		const client = makeClient();
		try {
			await client.start();
			await client.waitForInteractiveEngineBound();
			const enginePid = client.getEnginePid();
			assert.ok(enginePid, "engine child never reported its pid");

			let chunks = 0;
			const pending = client
				.userBashWithUpdates(`touch ${JSON.stringify(marker)} && sleep 400`, () => {
					chunks += 1;
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);

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
	},
	60_000,
);

serialTest(
	"a send the child never received stays restorable",
	async () => {
		const client = makeClient();
		try {
			await client.start();
			await client.waitForInteractiveEngineBound();
			// Detach the writer exactly as a dying transport would, before the frame
			// can reach the child: no admission can exist for this request.
			const stopped = client.stop();
			const error = await client.prompt("never delivered").then(
				() => undefined,
				(reason: unknown) => reason,
			);
			await stopped;

			assert.ok(isRpcTransportFailure(error));
			assert.equal(isRpcRequestAcceptedFailure(error), false, "an undelivered frame must not look accepted");
			assert.equal(isEngineSendFailure(error), true, "the exact draft must still be restorable");
		} finally {
			await client.stop();
		}
	},
	60_000,
);

serialTest(
	"a queued admission frame is parsed before the exit rejection",
	async () => {
		// The fixture admits and exits in the same turn, so the frame is still in the
		// pipe when `exit` fires — the ordering a real dying child cannot be made to
		// reproduce on demand.
		const client = new RpcClient({
			cliPath: join(moduleDir(import.meta.url), "fixtures", "admission-race-engine.ts"),
			cwd: join(moduleDir(import.meta.url), "../.."),
			runtimeExecutable: bunExecutable(),
			interactiveEngine: { onDiagnostic: () => {} },
		});
		try {
			await client.start();
			const error = await client.prompt("admit then die").then(
				() => undefined,
				(reason: unknown) => reason,
			);
			assert.ok(isRpcTransportFailure(error), "the death is still a transport failure");
			assert.ok(isRpcRequestAcceptedFailure(error), "the exit rejection outran the queued admission frame");
			assert.equal(isEngineSendFailure(error), false);
		} finally {
			await client.stop();
		}
	},
	60_000,
);

/**
 * The round-nine race: the admission frame sits behind several reader turns and
 * a descendant holds stdout open, while automatic recovery starts in the same
 * turn as the death event. Recovery used to detach the reader, retire the
 * generation, and re-reject with `Agent process stopped`, so the queued
 * admission never landed and already-running work was offered back to the user.
 */
serialTest(
	"an admitted command is never restored when automatic recovery starts before dead stdout drains",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-admission-backlog-"));
		const marker = join(temp, "side-effect");
		const generations = join(temp, "generations");
		const client = new RpcClient({
			cliPath: join(moduleDir(import.meta.url), "fixtures", "admission-backlog-engine.ts"),
			cwd: join(moduleDir(import.meta.url), "../.."),
			runtimeExecutable: bunExecutable(),
			env: { ATOMIC_ADMISSION_MARKER: marker, ATOMIC_ADMISSION_GENERATION: generations },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		// Exactly the runtime's shape: recovery begins synchronously on death.
		let recovery: Promise<unknown> | undefined;
		client.onGenerationEnded((event) => {
			if (event.expected || recovery) return;
			recovery = client.restart(undefined).then(
				() => undefined,
				(error: unknown) => error,
			);
		});
		try {
			await client.start();
			const failure = await client.prompt("quiet command with side effects").then(
				() => undefined,
				(error: unknown) => error,
			);

			assert.equal(existsSync(marker), true, "the child never ran the work this test is about");
			assert.ok(isRpcTransportFailure(failure), "engine death must still be a transport failure");
			assert.ok(isRpcRequestAcceptedFailure(failure), "recovery discarded the queued admission frame");
			assert.match(
				(failure as Error).message,
				/Agent process exited/,
				"the stop performed by recovery must not relabel the original exit",
			);
			assert.equal(isEngineSendFailure(failure), false, "already-running work must not be restorable");

			assert.equal(await recovery, undefined, "automatic recovery did not complete");
			assert.ok(client.getEnginePid(), "the replacement generation never became ready");
			assert.equal(
				readFileSync(generations, "utf8").trim().split("\n").length,
				2,
				"expected exactly one replacement generation",
			);
		} finally {
			await client.stop();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	60_000,
);

/**
 * Explicit stop is a terminal cause like any other: a request the child had
 * already taken must not become restorable just because the user, a recovery
 * replacement, or disposal was the one that ended the generation.
 */
serialTest(
	"an explicit stop preserves ownership of a request the child had taken",
	async () => {
		// A fixture that admits and then stays silent: only the host can end this
		// request, so the stop path is the one under test rather than a race with a
		// real child's shutdown response.
		const client = new RpcClient({
			cliPath: join(moduleDir(import.meta.url), "fixtures", "admission-race-engine.ts"),
			cwd: join(moduleDir(import.meta.url), "../.."),
			runtimeExecutable: bunExecutable(),
			env: { ATOMIC_ADMISSION_HOLD: "1" },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		try {
			await client.start();
			const pending = client.prompt("taken but never answered").then(
				() => undefined,
				(error: unknown) => error,
			);
			await sleep(100);

			await client.stop();
			const failure = await pending;

			assert.ok(isRpcTransportFailure(failure), "a stop is still a transport failure");
			assert.ok(isRpcRequestAcceptedFailure(failure), "the stop discarded the admission the child had sent");
			assert.match((failure as Error).message, /Agent process stopped/, "a deliberate stop keeps its own wording");
			assert.equal(isEngineSendFailure(failure), false, "work the child had taken must not be restorable");
		} finally {
			await client.stop();
		}
	},
	60_000,
);
