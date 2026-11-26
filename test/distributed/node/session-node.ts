/**
 * Session commands of one distributed-test node that test/fixtures/multinode-resume-node.ts does not have, run with
 * Bun as a process of its own, with the node's HOME, agent directory and ATOMIC_STORAGE. Prints one JSON line.
 *
 *   fork <json>     forks a session the way `atomic --fork <id>` does, runs a turn in the fork that reads `readPath`,
 *                   and prints the fork's id, where it continues, and what it read
 *   inspect <json>  prints a session's parent, its user messages and its entry ids, as stored
 *   writer <json>   creates a session and appends one entry at a time until `stopFile` exists, through the store
 *                   Atomic opens. It records each entry the store acknowledged in `ackFile` before it writes the next,
 *                   and each failure it retried. A failure whose outcome is unknown is resolved by reading the
 *                   session back, as SessionManager does. Prints {"sessionId"} first and {"written"} last
 */
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { parseArgs } from "../../../packages/coding-agent/src/cli/args.ts";
import { getAgentDir } from "../../../packages/coding-agent/src/config.ts";
import { savedProjectTrust } from "../../../packages/coding-agent/src/core/resume/session-resume.ts";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.ts";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
} from "../../../packages/coding-agent/src/core/session-manager-types.ts";
import { createSessionId } from "../../../packages/coding-agent/src/core/session-manager-validation.ts";
import { resolveSessionStore } from "../../../packages/coding-agent/src/core/session-storage.ts";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import { selectProcessStorage } from "../../../packages/coding-agent/src/core/storage/process-selection.ts";
import type { SessionRecordHeader } from "../../../packages/coding-agent/src/core/storage/session/types.ts";
import { openCliSession } from "../../../packages/coding-agent/src/main-session.ts";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";
import { emit, emitFailure } from "../../fixtures/multinode-node-support.ts";

interface ForkArgs {
	readonly sessionId: string;
	readonly launchCwd: string;
	readonly readPath: string;
	readonly prompt: string;
}

interface WriterArgs {
	readonly cwd: string;
	readonly ackFile: string;
	readonly stopFile: string;
	readonly intervalMs: number;
}

interface InspectArgs {
	readonly sessionId: string;
}

/** The session a fork came from, as the header records it: `parentSessionId` once stored, `parentSession` before. */
function parentOf(manager: SessionManager): string | undefined {
	const header = manager.getHeader() as { parentSessionId?: string; parentSession?: string } | null;
	return header?.parentSessionId ?? header?.parentSession;
}

function userTexts(manager: SessionManager): string[] {
	return manager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content;
		return [
			typeof content === "string" ? content : content.map((part) => ("text" in part ? part.text : "")).join(""),
		];
	});
}

async function fork(args: ForkArgs): Promise<void> {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(args.launchCwd, agentDir);
	const opened = await openCliSession(parseArgs(["--fork", args.sessionId]), args.launchCwd, settings, {
		agentDir,
		trusted: savedProjectTrust(agentDir, settings),
	});
	if (opened === "cancelled") throw new Error("the fork was cancelled");
	const { sessionManager, notices } = opened;
	const harness = await createHarness({ sessionManager, cwd: sessionManager.getCwd() });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: args.readPath })], { stopReason: "toolUse" }),
		fauxAssistantMessage("continued in the fork"),
	]);
	await harness.session.prompt(args.prompt);
	const toolResult = sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.content] : [],
		)
		.at(-1);
	emit({
		sessionId: sessionManager.getSessionId(),
		parentSession: parentOf(sessionManager),
		cwd: realpathSync(sessionManager.getCwd()),
		notices,
		mappings: sessionManager.getWorktreeRootMappings(),
		userTexts: userTexts(sessionManager),
		toolResult,
	});
	await harness.cleanup();
	await sessionManager.getSessionStore().close();
}

async function inspect(args: InspectArgs): Promise<void> {
	const agentDir = getAgentDir();
	selectProcessStorage("sessions", agentDir, process.cwd());
	const store = await resolveSessionStore(process.cwd(), { agentDir, settings: {} });
	const manager = await SessionManager.open(store, args.sessionId);
	emit({
		sessionId: manager.getSessionId(),
		parentSession: parentOf(manager),
		userTexts: userTexts(manager),
		entryIds: manager.getEntries().map((entry) => entry.id),
	});
	await store.close();
}

function describeError(error: unknown): { name?: string; code?: string; message?: string } {
	const typed = error as { name?: string; code?: string; message?: string };
	return { name: typed.name, code: typed.code, message: typed.message?.split("\n")[0]?.slice(0, 200) };
}

async function writer(args: WriterArgs): Promise<void> {
	const agentDir = getAgentDir();
	selectProcessStorage("sessions", agentDir, args.cwd);
	const record = (event: object) => appendFileSync(args.ackFile, `${JSON.stringify({ ...event, at: Date.now() })}\n`);
	/** Runs `action` until it succeeds, recording each failure; gives up only when told to stop. */
	const persist = async <T>(step: string, action: () => Promise<T>): Promise<T> => {
		for (;;) {
			try {
				return await action();
			} catch (error) {
				record({ event: "error", step, error: describeError(error) });
				if (existsSync(args.stopFile)) throw error;
				await delay(250);
			}
		}
	};
	const store = await persist("open", () => resolveSessionStore(args.cwd, { agentDir, settings: {} }));
	const sessionId = createSessionId();
	const header: SessionRecordHeader = {
		id: sessionId,
		version: CURRENT_SESSION_VERSION,
		cwd: args.cwd,
		createdAt: new Date().toISOString(),
	};
	let lastSeq = await persist("create", async () => {
		try {
			return (await store.create(header, [])).lastSeq;
		} catch (error) {
			// A create whose outcome was unknown may have committed.
			const loaded = await store.load(sessionId).catch(() => undefined);
			if (loaded !== undefined) return loaded.lastSeq;
			throw error;
		}
	});
	emit({ sessionId });
	let parentId: string | null = null;
	let written = 0;
	while (!existsSync(args.stopFile)) {
		const entry = {
			type: "message",
			id: `w${String(written + 1).padStart(6, "0")}`,
			parentId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: `entry ${written + 1}`, timestamp: Date.now() },
		} as SessionEntry;
		const started = performance.now();
		lastSeq = await persist("append", async () => {
			try {
				return (await store.append(sessionId, [entry], { expectSeq: lastSeq })).lastSeq;
			} catch (error) {
				// The append may have committed: then the entry is the session's last one, now or a little later.
				for (let check = 0; check < 20; check++) {
					const loaded = await store.load(sessionId);
					if (loaded.entries.at(-1)?.id === entry.id) {
						record({ event: "resolved", id: entry.id, error: describeError(error) });
						return loaded.lastSeq;
					}
					if (loaded.lastSeq === lastSeq) break;
					await delay(250);
				}
				throw error;
			}
		});
		written++;
		parentId = entry.id;
		record({ event: "ack", id: entry.id, seq: lastSeq, ms: Math.round(performance.now() - started) });
		await delay(args.intervalMs);
	}
	emit({ sessionId, written });
	await store.close();
}

const [command, json] = process.argv.slice(2);
try {
	if (command === "fork") await fork(JSON.parse(json!) as ForkArgs);
	else if (command === "inspect") await inspect(JSON.parse(json!) as InspectArgs);
	else if (command === "writer") await writer(JSON.parse(json!) as WriterArgs);
	else throw new Error(`unknown command ${command}`);
	process.exit(0);
} catch (error) {
	emitFailure(error);
	process.exit(2);
}
