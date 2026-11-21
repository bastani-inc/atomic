import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { ActivityWatchdogDiagnostic } from "../src/modes/interactive-engine/activity-watchdog.ts";
import { RpcClient, type RpcEvent } from "../src/modes/rpc/rpc-client.js";

const tempDirs: string[] = [];
const clients: RpcClient[] = [];
const stopWatching: (() => void)[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.stop().catch(() => {});
	for (const stop of stopWatching.splice(0)) stop();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An engine child that reports ready, writes `frames`, and answers each command it is sent, after writing the next
 * batch of `batches`. A batch and its answer go out in one write, so the host reads them in one turn.
 */
function engine(
	batches: string[][],
	options: {
		interactive?: boolean;
		frames?: string[];
		stderr?: string;
		onHeartbeat?: () => void;
		onActivityChange?: (active: boolean) => void;
		/** The host's own reporter, called after the fixture keeps the diagnostic. */
		onDiagnostic?: (diagnostic: ActivityWatchdogDiagnostic) => void;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "atomic-host-listener-"));
	tempDirs.push(dir);
	const script = join(dir, "engine.mjs");
	const interactive = options.interactive ?? true;
	writeFileSync(
		script,
		`import { createInterface } from "node:readline";
const batches = ${JSON.stringify(batches)};
${interactive ? `process.stdout.write(JSON.stringify({ type: "engine_ready", protocolVersion: 4, pid: process.pid }) + "\\n");` : ""}
for (const frame of ${JSON.stringify(options.frames ?? [])}) process.stdout.write(frame + "\\n");
${options.stderr === undefined ? "" : `process.stderr.write(${JSON.stringify(options.stderr)});`}
let sent = 0;
createInterface({ input: process.stdin }).on("line", (input) => {
	const command = JSON.parse(input);
	const lines = batches[sent++] ?? [];
	const answer = JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: {} });
	process.stdout.write([...lines, answer].map((line) => line + "\\n").join(""));
});
process.stdin.on("end", () => process.exit(0));
`,
	);
	const diagnostics: ActivityWatchdogDiagnostic[] = [];
	const client = new RpcClient({
		cliPath: script,
		runtimeExecutable: process.execPath,
		...(interactive
			? {
					interactiveEngine: {
						onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => {
							diagnostics.push(diagnostic);
							return options.onDiagnostic?.(diagnostic);
						},
						...(options.onHeartbeat ? { onHeartbeat: options.onHeartbeat } : {}),
						...(options.onActivityChange ? { onActivityChange: options.onActivityChange } : {}),
					},
				}
			: {}),
	});
	clients.push(client);
	const ended: string[] = [];
	client.onGenerationEnded((event) => ended.push(event.kind));
	return {
		client,
		ended,
		diagnostics,
		reports: () => diagnostics.map(({ level, source, message }) => ({ level, source, message })),
	};
}

/** Collects every rejection nothing handled while the test runs. */
function unhandledRejections(): unknown[] {
	const unhandled: unknown[] = [];
	const record = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", record);
	stopWatching.push(() => process.off("unhandledRejection", record));
	return unhandled;
}

/** Resolves with the first exception nothing caught, so a test can tell one apart from a wait that never ends. */
function uncaughtException(): Promise<Error> {
	const caught = Promise.withResolvers<Error>();
	process.prependListener("uncaughtException", caught.resolve);
	stopWatching.push(() => process.off("uncaughtException", caught.resolve));
	return caught.promise;
}

const line = (frame: object) => JSON.stringify(frame);
const toolUpdate = (toolCallId: string) =>
	line({ type: "tool_execution_update", toolCallId, toolName: "bash", args: {}, partialResult: { content: [] } });
const messageUpdate = (delta: string) =>
	line({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta } });

function label(event: RpcEvent): string {
	if (event.type === "tool_execution_update") return `tool:${event.toolCallId}`;
	if (event.type === "message_update") return `delta:${(event.assistantMessageEvent as { delta: string }).delta}`;
	return event.type;
}

const hostFailure = (message: string) => ({ level: "unresponsive", source: "host", message });

describe("RpcClient host listener failures", () => {
	test("a listener that throws on a tool update is reported once and does not end Atomic (#6107)", async () => {
		const { client, ended, reports } = engine([[toolUpdate("a"), toolUpdate("b")]]);
		const crashed = uncaughtException();
		client.onEvent((event) => {
			if (label(event) === "tool:a") throw new Error("could not draw a");
		});
		const seen: string[] = [];
		const both = Promise.withResolvers<void>();
		client.onEvent((event) => {
			seen.push(label(event));
			if (seen.length === 2) both.resolve();
		});
		await client.start();

		// The updates wait for the buffer's timer, which delivers them after the answer.
		await client.getState();
		const crash = await Promise.race([both.promise, crashed]);

		assert.equal(crash, undefined);
		assert.deepEqual(seen, ["tool:a", "tool:b"]);
		assert.deepEqual(reports(), [
			hostFailure(
				`Atomic failed while handling the interactive engine's "tool_execution_update" event: could not draw a`,
			),
		]);
		await client.getState();
		assert.deepEqual(ended, []);
	});

	test("a listener that throws on an event is reported as its own failure, not as malformed engine output (#6107)", async () => {
		const { client, ended, reports } = engine([
			[line({ type: "message_start", message: {} }), messageUpdate("one"), messageUpdate("two")],
		]);
		client.onEvent((event) => {
			if (event.type === "message_update") throw new Error(`could not draw ${label(event)}`);
		});
		const seen: string[] = [];
		client.onEvent((event) => seen.push(label(event)));
		await client.start();

		await client.getState();

		assert.deepEqual(seen, ["message_start", "delta:one", "delta:two"]);
		assert.deepEqual(reports(), [
			hostFailure(
				`Atomic failed while handling the interactive engine's "message_update" event: could not draw delta:one`,
			),
			hostFailure(
				`Atomic failed while handling the interactive engine's "message_update" event: could not draw delta:two`,
			),
		]);
		await client.getState();
		assert.deepEqual(ended, []);
	});

	test("an engine message listener that throws does not stop the engine from binding (#6107)", async () => {
		const { client, ended, reports } = engine([], { frames: [line({ type: "engine_bound" })] });
		const crashed = uncaughtException();
		client.onInteractiveEngineMessage((message) => {
			if (message.type === "engine_bound") throw new Error("could not show the session");
		});
		await client.start();

		const crash = await Promise.race([client.waitForInteractiveEngineBound(), crashed]);

		assert.equal(crash, undefined);
		assert.deepEqual(reports(), [
			hostFailure(
				`Atomic failed while handling the interactive engine's "engine_bound" message: could not show the session`,
			),
		]);
		await client.getState();
		assert.deepEqual(ended, []);
	});

	test("an engine callback that throws, or a listener whose promise rejects, is reported and does not end Atomic (#6107)", async () => {
		const { client, ended, reports } = engine([], {
			frames: [
				line({ type: "engine_heartbeat", at: 1 }),
				line({
					type: "engine_keybindings_reloaded",
					state: { userBindings: {}, effectiveBindings: {}, shortcuts: [] },
				}),
			],
			onHeartbeat: () => {
				throw new Error("could not count the heartbeat");
			},
		});
		const crashed = uncaughtException();
		const unhandled: unknown[] = [];
		const record = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", record);
		stopWatching.push(() => process.off("unhandledRejection", record));
		client.onInteractiveEngineKeybindingState(async () => {
			throw new Error("could not apply the keybindings");
		});
		await client.start();

		// The engine wrote both frames before this answer, and a rejection settles before the next turn.
		const crash = await Promise.race([client.getState().then(() => undefined), crashed]);
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(crash, undefined);
		assert.deepEqual(unhandled, []);
		assert.deepEqual(reports(), [
			hostFailure(
				`Atomic failed while handling the interactive engine's "engine_heartbeat" message: could not count the heartbeat`,
			),
			hostFailure(
				`Atomic failed while handling the interactive engine's "engine_keybindings_reloaded" message: could not apply the keybindings`,
			),
		]);
		assert.deepEqual(ended, []);
	});

	test("a generation-ended listener that throws neither fails the stop nor hides the end from later listeners (#6107)", async () => {
		const { client, ended, reports } = engine([]);
		client.onGenerationEnded(() => {
			throw new Error("could not close the view");
		});
		const later: string[] = [];
		client.onGenerationEnded((event) => later.push(event.kind));
		await client.start();

		await client.stop();

		assert.deepEqual(ended, ["explicit-stop"]);
		assert.deepEqual(later, ["explicit-stop"]);
		assert.deepEqual(reports(), [
			hostFailure("Atomic failed while handling the end of the interactive engine: could not close the view"),
		]);
	});

	test("a line the engine wrote wrong is still reported as malformed engine output (#6107)", async () => {
		const { client, ended, reports } = engine([["[]", "{not json", "null", "0", '"text"']]);
		const seen: unknown[] = [];
		client.onEvent((event) => seen.push(event));
		await client.start();

		await client.getState();

		assert.deepEqual(seen, [[]], "an array is read as before, as an event");
		const malformed = {
			level: "unresponsive",
			source: undefined,
			message: "Interactive engine emitted malformed JSONL",
		};
		assert.deepEqual(reports(), [malformed, malformed, malformed, malformed]);
		assert.deepEqual(ended, ["transport-error"]);
	});

	test("a raw RPC client keeps working after one of its listeners throws (#6107)", async () => {
		const { client } = engine([[line({ type: "agent_end", messages: [] })], [line({ type: "agent_start" })]], {
			interactive: false,
		});
		client.onEvent((event) => {
			if (event.type === "agent_end") throw new Error("listener failed");
		});
		const seen: string[] = [];
		client.onEvent((event) => seen.push(event.type));
		await client.start();

		await client.getState();
		await client.getState();

		assert.deepEqual(seen.at(-1), "agent_start");
	});
	test("a heartbeat callback that fails on every heartbeat is one series of failures, not one per heartbeat", async () => {
		const heartbeat = line({ type: "engine_heartbeat", at: 1 });
		const { client, diagnostics } = engine([], {
			frames: [heartbeat, heartbeat, heartbeat],
			onHeartbeat: () => {
				throw new Error("could not count the heartbeat");
			},
		});
		await client.start();

		await client.getState();

		const failures = diagnostics.filter((diagnostic) => diagnostic.source === "host");
		assert.equal(failures.length, 3);
		assert.ok(failures[0]?.series);
		assert.ok(failures.every((failure) => failure.series === failures[0]?.series));
	});

	test("an activity callback that fails on every change is one series of failures", async () => {
		const activity = (id: string) =>
			line({ type: "engine_activity_started", activity: { id, kind: "tool.execute", name: "bash", startedAt: 1 } });
		const { client, diagnostics } = engine([], {
			frames: [activity("a"), activity("b")],
			onActivityChange: () => {
				throw new Error("could not show the activity");
			},
		});
		await client.start();

		await client.getState();

		// The callback is also told of the engine's readiness: a failure on another message, of its own series.
		const failures = diagnostics.filter(
			(diagnostic) => diagnostic.source === "host" && diagnostic.message.includes('"engine_activity_started"'),
		);
		assert.equal(failures.length, 2);
		assert.ok(failures[0]?.series);
		assert.equal(failures[1]?.series, failures[0]?.series);
	});

	test("a reporter that throws on a malformed line neither escapes nor keeps the generation from ending", async () => {
		const { client, ended } = engine([], {
			frames: ["{not json"],
			onDiagnostic: () => {
				throw new Error("could not show the error");
			},
		});
		const crashed = uncaughtException();
		const generationEnded = Promise.withResolvers<void>();
		client.onGenerationEnded(() => generationEnded.resolve());

		await client.start().catch(() => undefined);
		const crash = await Promise.race([generationEnded.promise, crashed]);

		assert.equal(crash, undefined);
		assert.deepEqual(ended, ["transport-error"]);
	});

	test("a reporter that throws or rejects on the engine's stderr does not end Atomic", async () => {
		for (const fails of ["throws", "rejects"] as const) {
			const reported = Promise.withResolvers<void>();
			const { client } = engine([], {
				stderr: "a warning from the engine\n",
				onDiagnostic: (diagnostic) => {
					if (diagnostic.source !== "stderr") return;
					reported.resolve();
					if (fails === "throws") throw new Error("could not show stderr");
					return Promise.reject(new Error("could not show stderr")) as never;
				},
			});
			const crashes: Error[] = [];
			void uncaughtException().then((error) => crashes.push(error));
			const unhandled = unhandledRejections();
			await client.start();

			await reported.promise;
			// An exception thrown from the report's turn, and a rejection, surface before the next turn ends.
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.deepEqual(crashes, [], fails);
			assert.deepEqual(unhandled, [], fails);
			await client.getState();
		}
	});
});
