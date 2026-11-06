#!/usr/bin/env node
// @ts-check
/**
 * Node-side driver of the `idle-density` suite (#4394): background subagents released on one node and woken by
 * Intercom sends that brokers on other nodes route through the shared store. It runs against the deployed ref,
 * loading the ref's TypeScript sources through the ref's own jiti, and records raw evidence as JSON lines; the
 * controller judges it (`test/distributed/harness/released.mjs`). Credentials are read from files and never printed.
 *
 *   owner --ref-dir D --dir W --children N <storage>
 *       Launches N background subagents through the subagent tool. Each starts a long shell task in the background and
 *       waits on it, so it is released. Writes `W/children.json` once every child is released, then keeps the owner
 *       session open and logs child status every few seconds. Restarted after a crash, it reopens the same session.
 *       SIGTERM logs the final status and exits.
 *   sender --ref-dir D --dir W --name S --children-file F [--workers K] [--pace-ms P] <storage>
 *       Sends numbered messages `ADT <S> <child> <k>` to every child through this node's own broker until `W/stop`
 *       exists. Each child's messages go out one at a time, in order. A send that loses its broker connection is
 *       retried with the same message id after Intercom's own reconnect delays; every outcome is logged with the
 *       fields the broker returned or the thrown error's name and code.
 *   inspect --ref-dir D --dir W
 *       After the owner stopped: every child's record, status and the Intercom messages its own session received.
 *
 * <storage> is `--url U --namespace N --token-file F --prefix P`. It becomes the `storage` setting of the node's own
 * agent directory `W/agent`, which the node's broker reads to route through the shared store. Sessions stay in a
 * node-local SQLite store (`W/owner.sqlite`); only Intercom routing is shared.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [command, ...rest] = process.argv.slice(2);
/** @type {Record<string, string>} */
const flags = {};
for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];

/** @param {string} name */
function flag(name) {
	const value = flags[name];
	if (value === undefined) throw new TypeError(`released ${command} needs --${name}`);
	return value;
}

/** @param {string} name @param {number} fallback */
function count(name, fallback) {
	const value = flags[name] === undefined ? fallback : Number(flags[name]);
	if (!Number.isInteger(value) || value < 0) throw new RangeError(`released ${command} --${name} must be an integer`);
	return value;
}

/** @param {unknown} value */
function print(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * A credential-free description of a thrown value: its name and code, the first line of its message with anything
 * shaped like a JWT removed, and the same for its causes.
 * @param {unknown} error
 * @param {number} [depth]
 * @returns {{ name: string, code: string | null, message: string, cause?: ReturnType<typeof describe> }}
 */
function describe(error, depth = 0) {
	if (typeof error !== "object" || error === null)
		return { name: "NonError", code: null, message: redact(String(error)) };
	const code = Reflect.get(error, "code");
	const cause = Reflect.get(error, "cause");
	return {
		name: String(Reflect.get(error, "name") ?? "Error"),
		code: typeof code === "string" ? code : null,
		message: redact(String(Reflect.get(error, "message") ?? "")),
		...(depth < 4 && typeof cause === "object" && cause !== null ? { cause: describe(cause, depth + 1) } : {}),
	};
}

/** @param {string} text */
function redact(text) {
	return (text.split("\n")[0] ?? "").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-jwt]").slice(0, 200);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const refDir = flag("ref-dir");
const dir = flag("dir");
const agentDir = join(dir, "agent");
const cwd = join(dir, "project");
const childrenFile = join(dir, "children.json");
const ownerFile = join(dir, "owner.json");
const ownerStore = join(dir, "owner.sqlite");
const OWNER_PROMPT = "ADT-OWNER: launch the workers.";
const WORKER_PREFIX = "Worker ";
const BUILD_SECONDS = 3600;

process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true, mode: 0o700 });

/**
 * Appends one evidence record to `W/<log>.jsonl`.
 * @param {string} log
 * @param {Record<string, unknown>} event
 */
function record(log, event) {
	appendFileSync(join(dir, `${log}.jsonl`), `${JSON.stringify({ ...event, at: Date.now() })}\n`, { mode: 0o600 });
}

/** Points the node's agent directory at the shared store, so its broker routes through it. */
function writeStorageSetting() {
	const storage = {
		adapter: join(refDir, "packages", "storage-libsql", "libsql.js"),
		options: { url: flag("url"), namespace: flag("namespace") },
		secrets: { authToken: { file: flag("token-file") } },
		prefix: flag("prefix"),
	};
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ storage })}\n`, { mode: 0o600 });
}

const refRequire = createRequire(join(refDir, "package.json"));
/** @param {string} name */
const packageDir = (name) => realpathSync(join(refDir, "node_modules", ...name.split("/")));

/** Registers the ref's jiti loader hooks, so the ref's TypeScript sources and its built packages share one module graph. */
async function registerTypeScript() {
	await import(pathToFileURL(join(dirname(refRequire.resolve("jiti/package.json")), "lib", "jiti-register.mjs")).href);
}

/**
 * A TypeScript module of the deployed ref. The jiti hooks load it as CommonJS, so its exports arrive as `default`.
 * @param {string} path a file of the deployed ref, relative to its root
 */
const source = async (path) => {
	const loaded = await import(pathToFileURL(join(refDir, path)).href);
	return loaded.default ?? loaded;
};

/**
 * @typedef {{ childId: string, state: string, terminalStatus?: string, intercomTarget?: string }} ChildRecord
 * @typedef {{ readSubagentChildRecords: (entries: readonly object[]) => Map<string, ChildRecord>,
 *   currentWakeFailure: (record: ChildRecord) => object | undefined, SUBAGENT_CHILD_RELEASED_STATUS: string }} RecordsModule
 * @typedef {{ type: string, customType?: string, details?: { message?: { id?: string, content?: { text?: string } } } }} SessionEntry
 * @typedef {{ getEntries: () => SessionEntry[], getSessionId: () => string, getSessionStore: () => object }} SessionManagerLike
 */

async function loadSessionModules() {
	await registerTypeScript();
	const atomic = await import(pathToFileURL(join(packageDir("@bastani/atomic"), "dist", "index.js")).href);
	/** @type {RecordsModule} */
	const records = await source("packages/subagents/src/runs/foreground/subagent-child-records.ts");
	const { reopenChildSession } = await source("packages/subagents/src/runs/foreground/subagent-child-session.ts");
	return { atomic, records, reopenChildSession };
}

/**
 * The owner's own session store: node-local SQLite.
 * @param {{ resolveSessionStore: (cwd: string, options: object) => Promise<object> }} atomic
 */
function openOwnerStore(atomic) {
	return atomic.resolveSessionStore(cwd, { agentDir, sessionStorePath: ownerStore });
}

/** @returns {{ sessionId: string } | undefined} */
function readOwnerFile() {
	return existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, "utf8")) : undefined;
}

/**
 * Child status counts from the owner session's records.
 * @param {RecordsModule} records
 * @param {readonly ChildRecord[]} all
 */
function statusOf(records, all) {
	const released = all.filter(
		(item) => item.state === "terminal" && item.terminalStatus === records.SUBAGENT_CHILD_RELEASED_STATUS,
	).length;
	const running = all.filter((item) => item.state === "running").length;
	return {
		children: all.length,
		released,
		running,
		other: all.length - released - running,
		wakeFailures: all.filter((item) => records.currentWakeFailure(item) !== undefined).length,
	};
}

/**
 * @typedef {{ role: string, content?: string | readonly { type: string, text?: string }[], toolName?: string,
 *   isError?: boolean, details?: { observation?: { kind?: string, taskId?: string } } }} ContextMessage
 */

/** @param {ContextMessage | undefined} message */
function textOf(message) {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

async function owner() {
	const children = count("children", 0);
	if (children === 0) throw new RangeError("released owner --children must be at least 1");
	writeStorageSetting();
	const { atomic, records } = await loadSessionModules();
	const compat = await import(pathToFileURL(join(packageDir("@bastani/pi-ai"), "dist", "compat.js")).href);
	mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".atomic", "agents", "worker.md"),
		"---\nname: worker\ndescription: waits on its build and reads its messages\ntools: bash, intercom\n---\nWait for your build, and read every message that arrives.\n",
	);
	const faux = compat.registerFauxProvider({ tokenSize: { min: 5, max: 5 } });
	const model = faux.getModel();
	const authStorage = atomic.AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await atomic.ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(dir, "models.json"),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	/** @param {{ messages: readonly ContextMessage[] }} context */
	const respond = (context) => {
		const first = textOf(context.messages.find((message) => message.role === "user"));
		const last = context.messages.at(-1);
		if (first.includes(OWNER_PROMPT)) {
			const launched = context.messages.some(
				(message) => message.role === "toolResult" && message.toolName === "subagent",
			);
			if (launched || last?.role === "toolResult") return compat.fauxAssistantMessage("Noted.");
			return compat.fauxAssistantMessage(
				Array.from({ length: children }, (_, index) =>
					compat.fauxToolCall("subagent", {
						agent: "worker",
						task: `${WORKER_PREFIX}${index}: wait for your build, then read every message that arrives.`,
						wait: { kind: "background" },
					}),
				),
				{ stopReason: "toolUse" },
			);
		}
		const shellResults = context.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "bash",
		);
		const latest = shellResults.at(-1);
		const lastYielded = shellResults.findLast((message) => message.details?.observation?.kind === "yielded");
		const finished =
			lastYielded === undefined ||
			latest?.isError === true ||
			(latest?.details?.observation !== undefined && latest.details.observation.kind !== "yielded");
		if (finished)
			return compat.fauxAssistantMessage(
				[
					compat.fauxText("Starting my build."),
					compat.fauxToolCall("bash", {
						command: `sleep ${BUILD_SECONDS - 100}`,
						timeout: BUILD_SECONDS,
						wait: { kind: "background" },
					}),
				],
				{ stopReason: "toolUse" },
			);
		return compat.fauxAssistantMessage(
			[
				compat.fauxText("Waiting for my build."),
				compat.fauxToolCall("bash", { action: "wait", id: lastYielded?.details?.observation?.taskId }),
			],
			{ stopReason: "toolUse" },
		);
	};
	const topUp = () => {
		if (faux.getPendingResponseCount() < 500) faux.appendResponses(Array.from({ length: 1000 }, () => respond));
	};
	topUp();

	const store = await openOwnerStore(atomic);
	const previous = readOwnerFile();
	/** @type {SessionManagerLike} */
	const sessionManager =
		previous === undefined
			? await atomic.SessionManager.create(store, cwd)
			: await atomic.SessionManager.open(store, previous.sessionId);
	if (previous === undefined) writeFileSync(ownerFile, JSON.stringify({ sessionId: sessionManager.getSessionId() }));
	record("owner", {
		event: "owner-start",
		pid: process.pid,
		sessionId: sessionManager.getSessionId(),
		reopened: previous !== undefined,
		children,
	});
	const { session } = await atomic.createAgentSession({
		cwd,
		agentDir,
		sessionManager,
		settingsManager: atomic.SettingsManager.create(cwd, agentDir),
		model,
		modelRuntime,
		builtins: { intercom: true, subagents: true, workflows: false, mcp: false, "web-access": false },
		extensionBindings: { mode: "print" },
	});
	const current = () => [...records.readSubagentChildRecords(sessionManager.getEntries()).values()];
	let stopping = false;
	process.on("SIGTERM", () => {
		stopping = true;
	});
	if (previous === undefined) {
		await session.prompt(OWNER_PROMPT);
		record("owner", { event: "launched", children });
	} else {
		record("owner", { event: "owner-rebound", ...statusOf(records, current()) });
	}
	const allReleased = () => {
		const status = statusOf(records, current());
		return status.children === children && status.released === children;
	};
	if (!existsSync(childrenFile)) {
		while (!stopping && !allReleased()) {
			topUp();
			await sleep(1000);
		}
	}
	if (!stopping && !existsSync(childrenFile)) {
		const names = current().map((item) => ({ childId: item.childId, name: item.intercomTarget ?? item.childId }));
		writeFileSync(`${childrenFile}.tmp`, JSON.stringify(names));
		renameSync(`${childrenFile}.tmp`, childrenFile);
		record("owner", { event: "all-released", children: names.length });
	}
	while (!stopping) {
		topUp();
		record("owner", { event: "status", ...statusOf(records, current()) });
		for (let waited = 0; waited < 5000 && !stopping; waited += 250) await sleep(250);
	}
	record("owner", { event: "final-status", ...statusOf(records, current()) });
	await session.dispose();
	record("owner", { event: "owner-stopped" });
	process.exit(0);
}

/**
 * @typedef {{ id: string, delivered: boolean, queued?: boolean, reason?: string, reasonCode?: string }} SendResult
 * @typedef {{ connect: (session: object) => Promise<void>, disconnect: () => Promise<void>,
 *   send: (to: string, options: { text: string, messageId: string }) => Promise<SendResult>,
 *   on: (event: "error" | "disconnected", listener: (error: unknown) => void) => void }} Client
 */

async function sender() {
	const name = flag("name");
	const workers = count("workers", 4);
	const paceMs = count("pace-ms", 1000);
	const log = `sender-${name}`;
	writeStorageSetting();
	await registerTypeScript();
	const { IntercomClient } = await source("packages/intercom/broker/client.ts");
	const { spawnBrokerIfNeeded } = await source("packages/intercom/broker/spawn.ts");
	const { DEFAULT_BROKER_COMMAND, DEFAULT_BROKER_ARGS } = await source("packages/intercom/config.ts");
	const { isRecoverableIntercomDisconnect } = await source("packages/intercom/recoverable-disconnect.ts");
	/** @type {{ RECONNECT_DELAYS_MS: readonly number[] }} */
	const { RECONNECT_DELAYS_MS } = await source("packages/intercom/retry-policy.ts");
	const { projectHomeGroup } = await source("packages/intercom/project-group.ts");
	/** The group the Intercom extension would join in this directory: the project's, since routing is multi-node. */
	const group = projectHomeGroup(cwd, agentDir, process.env, process.env) ?? "default";
	/** @type {{ childId: string, name: string }[]} */
	const children = JSON.parse(readFileSync(flag("children-file"), "utf8"));
	const stopFile = join(dir, "stop");

	/** @type {Client | undefined} */
	let client;
	/** @type {Promise<Client> | undefined} */
	let connecting;
	let generation = 0;
	/** One connection at a time: every worker that lost it waits for the same replacement. */
	const connected = () => {
		if (client !== undefined) return Promise.resolve(client);
		connecting ??= (async () => {
			try {
				await spawnBrokerIfNeeded(DEFAULT_BROKER_COMMAND, [...DEFAULT_BROKER_ARGS]);
				/** @type {Client} */
				const fresh = new IntercomClient(`adt-sender-${name}-${randomUUID()}`);
				const at = generation + 1;
				fresh.on("error", (error) =>
					record(log, { event: "connection-error", generation: at, error: describe(error) }),
				);
				fresh.on("disconnected", (error) => {
					record(log, { event: "disconnected", generation: at, error: describe(error) });
					if (client === fresh) client = undefined;
				});
				try {
					await fresh.connect({
						name: `adt-sender-${name}`,
						model: "none",
						cwd,
						pid: process.pid,
						status: "idle",
						startedAt: Date.now(),
						lastActivity: Date.now(),
						group,
						groups: [group],
					});
				} catch (error) {
					fresh
						.disconnect()
						.catch((failure) => record(log, { event: "disconnect-failed", error: describe(failure) }));
					throw error;
				}
				client = fresh;
				record(log, { event: "connected", generation: ++generation });
				return fresh;
			} finally {
				connecting = undefined;
			}
		})();
		return connecting;
	};
	/** @param {Client} lost */
	const discard = (lost) => {
		if (client !== lost) return;
		client = undefined;
		lost.disconnect().catch((error) => record(log, { event: "disconnect-failed", error: describe(error) }));
	};

	/** @param {{ name: string }} child @param {number} k */
	const sendOne = async (child, k) => {
		const id = randomUUID();
		const text = `ADT ${name} ${child.name} ${k}`;
		const started = performance.now();
		record(log, { event: "send-start", child: child.name, k, id });
		for (let retries = 0; ; retries++) {
			/** @type {Client | undefined} */
			let used;
			try {
				used = await connected();
				const result = await used.send(child.name, { text, messageId: id });
				record(log, {
					event: "send",
					child: child.name,
					k,
					id,
					resultId: result.id,
					delivered: result.delivered === true,
					queued: result.queued === true,
					reason: result.reason ?? null,
					reasonCode: result.reasonCode ?? null,
					retries,
					ms: Math.round(performance.now() - started),
				});
				return;
			} catch (error) {
				const recoverable = isRecoverableIntercomDisconnect(error);
				if (recoverable && used !== undefined) discard(used);
				if (!recoverable || retries >= RECONNECT_DELAYS_MS.length) {
					record(log, { event: "send-failed", child: child.name, k, id, error: describe(error), retries });
					return;
				}
				await sleep(RECONNECT_DELAYS_MS[retries]);
			}
		}
	};

	record(log, { event: "sender-start", pid: process.pid, children: children.length, workers, group });
	/** @type {{ name: string }[][]} */
	const lanes = Array.from({ length: Math.min(workers, children.length) }, () => []);
	children.forEach((child, index) => {
		lanes[index % lanes.length].push(child);
	});
	await Promise.all(
		lanes.map(async (lane) => {
			for (let k = 1; ; k++) {
				for (const child of lane) {
					if (existsSync(stopFile)) return;
					await sendOne(child, k);
					await sleep(paceMs);
				}
			}
		}),
	);
	record(log, { event: "sender-done" });
	if (client !== undefined) await client.disconnect();
	process.exit(0);
}

async function inspect() {
	const { atomic, records, reopenChildSession } = await loadSessionModules();
	const saved = readOwnerFile();
	if (saved === undefined) throw new Error(`no owner session recorded in ${ownerFile}`);
	const store = await openOwnerStore(atomic);
	/** @type {SessionManagerLike} */
	const sessionManager = await atomic.SessionManager.open(store, saved.sessionId);
	const all = [...records.readSubagentChildRecords(sessionManager.getEntries()).values()];
	const children = [];
	for (const item of all) {
		/** @type {{ sessionManager: SessionManagerLike } | { reason: string }} */
		const reopened = await reopenChildSession({ sessionManager }, item);
		const messages =
			"sessionManager" in reopened
				? reopened.sessionManager.getEntries().flatMap((entry) => {
						const message = entry.details?.message;
						return entry.type === "custom_message" &&
							entry.customType === "intercom_message" &&
							typeof message?.id === "string"
							? [{ id: message.id, text: message.content?.text ?? "" }]
							: [];
					})
				: [];
		children.push({
			childId: item.childId,
			name: item.intercomTarget ?? item.childId,
			state: item.state,
			terminalStatus: item.terminalStatus ?? null,
			wakeFailure: records.currentWakeFailure(item) !== undefined,
			readable: "sessionManager" in reopened,
			messages,
		});
	}
	print({ status: statusOf(records, all), children });
	process.exit(0);
}

/** @type {Record<string, () => Promise<void>>} */
const commands = { owner, sender, inspect };
const handler = commands[command ?? ""];
if (handler === undefined) {
	process.stderr.write(`unknown released command ${command}\n`);
	process.exit(2);
}
const log = command === "owner" ? "owner" : command === "sender" ? `sender-${flags.name}` : undefined;
/**
 * Records a failure that ends the process: its name, code and first message line in the evidence, and its
 * stack in the unit's own log for diagnosis.
 * @param {"uncaught" | "fatal"} event
 * @param {unknown} error
 */
function fail(event, error) {
	if (log !== undefined) record(log, { event, error: describe(error) });
	process.stderr.write(
		`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`.replace(
			/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
			"[redacted-jwt]",
		),
	);
	print({ fatal: describe(error) });
	process.exit(1);
}
process.on("uncaughtException", (error) => fail("uncaught", error));
try {
	await handler();
} catch (error) {
	fail("fatal", error);
}
