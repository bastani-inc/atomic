import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionEntry } from "@bastani/atomic";
import { afterAll, test, vi } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-durable-inbox-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getBrokerPidPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

/** A real broker plus a separate recipient process loaded through jiti, then a sender wait past a kill. */
const CRASH_RESUME_TEST_TIMEOUT_MS = 90_000;
const CHILD_READY_TIMEOUT_MS = 30_000;
const SHOWN_TIMEOUT_MS = 20_000;
const BUSY_UPDATES = 6;
const RECIPIENT = "busy-parent";
const RECIPIENT_SESSION_ID = "busy-parent-session";

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: object) => void;
interface ShownMessage {
	details?: { message?: { id?: string } };
}

const children: ChildProcess[] = [];

afterAll(() => {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	try {
		const pid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);
		if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGKILL");
	} catch {
		// No broker was spawned, or it already exited.
	}
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** Start the busy recipient in its own process and wait until it is registered with the broker. */
async function startBusyRecipient(journal: string): Promise<ChildProcess> {
	const jitiCli = join(dirname(createRequire(import.meta.url).resolve("jiti/package.json")), "lib", "jiti-cli.mjs");
	const child = spawn(
		process.execPath,
		[jitiCli, join(repoRoot, "test/helpers/intercom-busy-recipient.ts"), journal, RECIPIENT, RECIPIENT_SESSION_ID],
		{ cwd: repoRoot, env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] },
	);
	children.push(child);
	let stdout = "";
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	await new Promise<void>((resolveReady, rejectReady) => {
		const timer = setTimeout(
			() => rejectReady(new Error(`busy recipient never became ready:\n${stderr}`)),
			CHILD_READY_TIMEOUT_MS,
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.includes("READY")) {
				clearTimeout(timer);
				resolveReady();
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			rejectReady(new Error(`busy recipient exited with ${code}:\n${stderr}`));
		});
	});
	assert.doesNotMatch(stdout, /SHOWN/);
	return child;
}

function readJournal(journal: string): SessionEntry[] {
	return readFileSync(journal, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SessionEntry);
}

/** The same session resumed in this process from exactly the entries the killed process saved. */
function resumedRecipient(branch: SessionEntry[]) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const shown: string[] = [];
	const record = (message: ShownMessage) => {
		const id = message.details?.message?.id;
		if (typeof id === "string") shown.push(id);
	};
	const context = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "resumed-model" },
		sessionManager: {
			getSessionId: () => RECIPIENT_SESSION_ID,
			getEntries: () => branch,
			getBranch: () => branch,
		},
		ui: { confirm: async () => true, notify() {} },
	};
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry(customType: string, data?: object) {
			branch.push({
				type: "custom",
				id: `resumed-${branch.length}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			});
		},
		async sendMessage(message: ShownMessage) {
			record(message);
		},
		async sendMessages(messages: ShownMessage[]) {
			for (const message of messages) record(message);
		},
		getSessionName: () => RECIPIENT,
		setSessionName() {},
		getActiveTools: () => [],
		setActiveTools() {},
		events: {
			on(eventName: string, handler: EventHandler) {
				eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
				return () => {};
			},
			emit(eventName: string, payload: object) {
				for (const handler of eventHandlers.get(eventName) ?? []) handler(payload);
			},
		},
	};
	const fire = async (eventName: string, event: object): Promise<void> => {
		for (const handler of handlers.get(eventName) ?? []) await handler(event, context);
	};
	return { pi, fire, shown };
}

test(
	"every update the sender saw delivered to a busy parent killed before idle is replayed exactly once on resume (#3761)",
	async () => {
		const journal = join(agentDir, "busy-parent.jsonl");
		const recipient = await startBusyRecipient(journal);
		const sender = new IntercomClient("progress-subagent");
		await sender.connect({
			name: "progress-subagent",
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		});
		let resumed: ReturnType<typeof resumedRecipient> | undefined;
		try {
			const delivered: string[] = [];
			for (let index = 1; index <= BUSY_UPDATES; index++) {
				const result = await sender.send(RECIPIENT, { messageId: `update-${index}`, text: `progress ${index}` });
				assert.equal(result.delivered, true, `update-${index}: ${result.reason ?? ""}`);
				delivered.push(result.id);
			}
			// One more update is in flight when the busy parent dies without ever going idle.
			const inFlight = sender.send(RECIPIENT, { messageId: "update-in-flight", text: "progress in flight" });
			recipient.kill("SIGKILL");
			await new Promise((resolveExit) => recipient.once("exit", resolveExit));

			const saved = readJournal(journal);
			const branch = resumedRecipient(saved);
			resumed = branch;
			intercomLightweight(branch.pi as never);
			await branch.fire("session_start", { type: "session_start", reason: "resume" });
			await branch.fire("session_recovery_restore", { type: "session_recovery_restore", reason: "resume" });

			const inFlightResult = await inFlight;
			if (inFlightResult.delivered) delivered.push(inFlightResult.id);
			await vi.waitFor(
				() => {
					for (const id of delivered) assert.ok(branch.shown.includes(id), `${id} was not replayed`);
				},
				{ timeout: SHOWN_TIMEOUT_MS },
			);
			assert.equal(new Set(branch.shown).size, branch.shown.length, `shown twice: ${branch.shown.join(", ")}`);
			assert.deepEqual(
				branch.shown.filter((id) => id !== "update-in-flight"),
				delivered.filter((id) => id !== "update-in-flight"),
				"replayed in the order they arrived",
			);
		} finally {
			await sender.disconnect().catch(() => undefined);
			await resumed?.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
	},
	CRASH_RESUME_TEST_TIMEOUT_MS,
);

test(
	"the real broker sends an unconfirmed message again when its recipient registers again, and delivered waits for the save (#3761)",
	async () => {
		const registration = (name: string) => ({
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		});
		const sender = new IntercomClient("redelivery-sender");
		const first = new IntercomClient("redelivery-recipient-home", { acknowledgesReceipt: true });
		const second = new IntercomClient("redelivery-recipient-home", { acknowledgesReceipt: true });
		try {
			await sender.connect(registration("redelivery-sender"));
			await first.connect(registration("redelivery-recipient"));
			const firstCopy = Promise.withResolvers<string>();
			first.on("message", (_from: object, message: { id: string }) => firstCopy.resolve(message.id));
			let settled = false;
			const result = sender.send("redelivery-recipient", { messageId: "redelivered-1", text: "save me" });
			void result.then(() => {
				settled = true;
			});
			assert.equal(await firstCopy.promise, "redelivered-1");
			await first.disconnect();
			assert.equal(settled, false, "a written but unsaved message is not delivered");

			const secondCopy = Promise.withResolvers<string>();
			second.on("message", (_from: object, message: { id: string }) => {
				secondCopy.resolve(message.id);
				second.acknowledgeReceived(message.id);
			});
			await second.connect(registration("redelivery-recipient"));
			assert.equal(await secondCopy.promise, "redelivered-1");
			assert.equal((await result).delivered, true);
		} finally {
			await Promise.all([sender, first, second].map((client) => client.disconnect().catch(() => undefined)));
		}
	},
	CRASH_RESUME_TEST_TIMEOUT_MS,
);
