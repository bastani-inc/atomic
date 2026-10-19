/**
 * #3761 crash fixture: a real Intercom runtime for a session that stays busy and never goes idle.
 * Every session entry it appends is fsynced to a JSONL journal, the stand-in for the session store, so the parent
 * test can `kill -9` this process and resume from exactly what reached the disk.
 * Usage: <jiti> intercom-busy-recipient.ts <journal> <session-name> <session-id>
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import { INTERCOM_RECOVERY_PEERS_EVENT } from "../../packages/intercom/session-recovery.js";

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: object) => void;

const [journal, name, sessionId] = process.argv.slice(2);
if (!journal || !name || !sessionId) throw new Error("usage: intercom-busy-recipient <journal> <name> <session-id>");

const entries: object[] = [];
const handlers = new Map<string, Handler[]>();
const eventHandlers = new Map<string, EventHandler[]>();
let shown = 0;
const events = {
	on(eventName: string, handler: EventHandler) {
		eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
		return () => {};
	},
	emit(eventName: string, payload: object) {
		for (const handler of eventHandlers.get(eventName) ?? []) handler(payload);
	},
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
		const entry = {
			type: "custom",
			id: `entry-${entries.length}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			customType,
			data,
		};
		const descriptor = openSync(journal, "a");
		try {
			writeSync(descriptor, `${JSON.stringify(entry)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		entries.push(entry);
	},
	async sendMessage() {
		shown += 1;
	},
	async sendMessages() {
		shown += 1;
	},
	getSessionName: () => name,
	setSessionName() {},
	getActiveTools: () => [],
	setActiveTools() {},
	events,
};
const context = {
	hasUI: true,
	cwd: process.cwd(),
	isIdle: () => false,
	model: { id: "busy-model" },
	sessionManager: {
		getSessionId: () => sessionId,
		getEntries: () => entries,
		getBranch: () => entries,
	},
	ui: { confirm: async () => true, notify() {} },
};

intercomHeavy(pi as never);
async function start(): Promise<void> {
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, context);
	}
	const connected: { completion?: Promise<object[]> } = {};
	events.emit(INTERCOM_RECOVERY_PEERS_EVENT, connected);
	await connected.completion;
	process.stdout.write("READY\n");
	setInterval(() => {
		if (shown > 0) process.stdout.write(`SHOWN ${shown}\n`);
	}, 1_000);
}
void start();
