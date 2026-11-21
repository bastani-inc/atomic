import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { NODE_TS_SOURCE_ARGS } from "../helpers/node-ts-sources.js";
import {
	decodeStream,
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/event-loop-external-inspector.mjs");
const BLOCK_THRESHOLD_MS = 200;
/** Hold through several watchdog thresholds to expose interference with an intentional user pause. */
const USER_PAUSE_MS = BLOCK_THRESHOLD_MS * 3;
const REAL_INSPECTOR_CHILD_TIMEOUT_MS = 20_000;

interface InspectorMessage {
	readonly id?: number;
	readonly method?: string;
	readonly error?: { readonly message: string };
}

// The current test runner's Node is also the child runtime, covering each supported CI Node version.
test("a user's inspector pause remains theirs and diagnostics still sample the next real stall (#5544)", async () => {
	const root = makeTempDirectory("event-loop-user-inspector-");
	const go = join(root, "go");
	const log = join(root, "blocks.jsonl");
	const child = spawnProcess([process.execPath, "--inspect=0", ...NODE_TS_SOURCE_ARGS, FIXTURE, go], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
			ATOMIC_EVENT_LOOP_BLOCK_MS: String(BLOCK_THRESHOLD_MS),
			ATOMIC_EVENT_LOOP_BLOCK_STACKS: undefined,
			ATOMIC_EVENT_LOOP_BLOCK_LOG: log,
		},
	});
	let output = "";
	let errors = "";
	let socket: WebSocket | undefined;
	const deadline = performance.now() + REAL_INSPECTOR_CHILD_TIMEOUT_MS;
	const timer = setTimeout(() => child.kill("SIGKILL"), REAL_INSPECTOR_CHILD_TIMEOUT_MS);
	async function waitFor(condition: () => boolean, label: string): Promise<void> {
		while (!condition()) {
			assert.ok(performance.now() < deadline, `${label}\n${output}\n${errors}`);
			await sleep(10);
		}
	}
	const drain = async (stream: NonNullable<typeof child.stdout>, append: (text: string) => void) => {
		const reader = decodeStream(stream).getReader();
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			append(next.value);
		}
	};
	assert.ok(child.stdout && child.stderr);
	const drains = [drain(child.stdout, (text) => (output += text)), drain(child.stderr, (text) => (errors += text))];
	try {
		await waitFor(() => output.includes("monitor ready") && /ws:\/\/[^\s]+/.test(errors), "inspector startup");
		const url = errors.match(/ws:\/\/[^\s]+/)?.[0];
		assert.ok(url);
		socket = new WebSocket(url);
		const client = socket;
		let nextId = 0;
		let paused = false;
		let resumed = false;
		const replies = new Map<number, InspectorMessage>();
		client.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as InspectorMessage;
			if (message.id !== undefined) replies.set(message.id, message);
			if (message.method === "Debugger.paused") paused = true;
			if (message.method === "Debugger.resumed") resumed = true;
		});
		await waitFor(() => client.readyState === WebSocket.OPEN, "inspector connection");
		async function post(method: string): Promise<void> {
			const id = ++nextId;
			client.send(JSON.stringify({ id, method }));
			await waitFor(() => replies.has(id), method);
			assert.equal(replies.get(id)?.error, undefined, method);
		}
		await post("Debugger.enable");
		writeFileSync(go, "go");
		await waitFor(() => paused, "the user breakpoint");
		await sleep(USER_PAUSE_MS);
		assert.equal(resumed, false, "the sampler must never resume the user's breakpoint");
		assert.equal(output.includes("after user breakpoint"), false);
		await post("Debugger.resume");
		await waitFor(() => output.includes("monitor finished"), "application completion after the user's resume");
		client.close();
		assert.equal(await child.exited, 0, `${output}\n${errors}`);
		const records = readTextSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; durationMs?: number; stacks?: { frames: string[] }[] });
		assert.ok(
			records.some(
				(record) =>
					record.type === "block" &&
					(record.durationMs ?? 0) >= BLOCK_THRESHOLD_MS &&
					record.stacks?.some((stack) =>
						stack.frames.some((frame) => frame.startsWith("holdAfterUserBreakpoint ")),
					),
			),
			`the real 600 ms stall still has its own stack: ${JSON.stringify(records)}`,
		);
	} finally {
		clearTimeout(timer);
		socket?.close();
		child.kill("SIGKILL");
		await Promise.all([child.exited, ...drains]);
		removeTempDirectory(root);
	}
});
