/**
 * The fixture of the interactive event-loop guard (test/integration/interactive-event-loop-guard.test.ts): an agent
 * directory whose only model is a scripted loopback provider, a workflow, a large resumable session, the package laid
 * out as npm installs it, and the records the event-loop diagnostic writes.
 */
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileExistsSync, readTextSync } from "./runtime.js";
import { type ChatRequest, messageText, type ScriptedReply } from "./scripted-chat-server.js";

export const STREAM_MARKER = "GUARD-STREAM";
export const SUBAGENTS_MARKER = "GUARD-SUBAGENTS";
const CHILD_MARKER = "GUARD-CHILD";
const STAGE_MARKER = "GUARD-STAGE";
const PROVIDER = "guard-loopback";
const MODEL = "guard-model";

/** A long markdown answer: headings, lists, code and a table, the shapes the renderer works hardest on. */
function longMarkdown(sections: number): string {
	const parts: string[] = [];
	for (let section = 1; section <= sections; section++) {
		parts.push(
			`## Section ${section}\n\nThe change keeps the **event loop** free while it renders \`section ${section}\`, and the list below covers each case.\n`,
			"- first item with `inline code` and a [link](https://example.com)\n- second item\n  - nested item\n- third item\n",
			"```ts\nexport function handle(input: string): number {\n\tconst trimmed = input.trim();\n\treturn trimmed.length * 2;\n}\n```\n",
			"| Column | Value |\n|---|---|\n| alpha | 1 |\n| beta | 2 |\n",
		);
	}
	return parts.join("\n");
}

/** What the scripted model answers, named by the label the guard waits for. */
export type GuardReply = ScriptedReply & {
	readonly label: "stream" | "parent" | "parent-final" | "child" | "stage" | "other";
};

/**
 * The scripted model. A prompt with `STREAM_MARKER` streams a long answer for about six seconds; one with
 * `SUBAGENTS_MARKER` delegates to four workers, whose prompts and the workflow's stage prompts each stream a shorter
 * answer; anything else (workflow notices, for instance) gets a one-word reply.
 */
export function guardReply(request: ChatRequest): GuardReply {
	const last = request.messages.at(-1);
	const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
	const prompt = messageText(lastUser);
	if (last?.role === "tool" && prompt.includes(SUBAGENTS_MARKER)) {
		return { label: "parent-final", text: `${SUBAGENTS_MARKER}-DONE.`, chunks: 4, chunkDelayMs: 20 };
	}
	if (prompt.includes(STREAM_MARKER)) {
		return { label: "stream", text: `${longMarkdown(24)}\n\n${STREAM_MARKER}-END`, chunks: 300, chunkDelayMs: 20 };
	}
	if (prompt.includes(SUBAGENTS_MARKER)) {
		return {
			label: "parent",
			text: "Delegating to four workers.",
			chunks: 4,
			chunkDelayMs: 20,
			toolCalls: [
				{
					name: "subagent",
					arguments: {
						context: "fresh",
						tasks: [1, 2, 3, 4].map((index) => ({
							agent: "worker",
							model: `${PROVIDER}/${MODEL}`,
							task: `${CHILD_MARKER} part ${index}`,
						})),
					},
				},
			],
		};
	}
	if (prompt.includes(CHILD_MARKER)) return { label: "child", text: longMarkdown(6), chunks: 120, chunkDelayMs: 20 };
	if (prompt.includes(STAGE_MARKER)) return { label: "stage", text: longMarkdown(6), chunks: 120, chunkDelayMs: 20 };
	return { label: "other", text: "ok", chunks: 1, chunkDelayMs: 0 };
}

export const GUARD_WORKFLOW = "event-loop-guard";
/** Stages the guard workflow runs: four in parallel, then a summary. */
export const GUARD_WORKFLOW_STAGES = 5;

const WORKFLOW_SOURCE = `import { workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "${GUARD_WORKFLOW}",
	description: "Four parallel stages and a summary, for the event-loop guard.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.parallel(
			[1, 2, 3, 4].map((index) => ({ name: \`branch-\${index}\`, prompt: \`${STAGE_MARKER} branch \${index}\`, context: "fresh" })),
		);
		await ctx.task("summary", { prompt: "${STAGE_MARKER} summary", context: "fresh" });
		return {};
	},
});
`;

/** An agent directory whose default model is the scripted provider at `baseUrl`, with the guard workflow. */
export function prepareAgentDir(agentDir: string, baseUrl: string): void {
	mkdirSync(join(agentDir, "workflows"), { recursive: true });
	const model = {
		id: MODEL,
		name: MODEL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// The resumed transcript is far larger than any real window; it must not be compacted on open.
		contextWindow: 100_000_000,
		maxTokens: 8_192,
	};
	const providers = { [PROVIDER]: { baseUrl, api: "openai-completions", apiKey: "guard", models: [model] } };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: PROVIDER,
			defaultModel: MODEL,
			lastChangelogVersion: "0.0.0",
			firstRunOnboardingStartedVersion: "0.0.0",
			onboardedVersion: "0.0.0",
			sessionSummary: { enabled: false },
		}),
	);
	writeFileSync(join(agentDir, `workflows/${GUARD_WORKFLOW}.ts`), WORKFLOW_SOURCE);
}

/**
 * The package at `packageRoot` as npm installs it, at `target`: metadata, `dist` and `docs`, and no `src`. Pointed at
 * by `ATOMIC_PACKAGE_DIR`, it makes the built CLI load its builtin extensions from the bundles in `dist/builtin`, as an
 * install does, rather than from the repository's TypeScript sources through jiti.
 */
export function prepareInstalledPackage(packageRoot: string, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const file of ["package.json", "CHANGELOG.md"]) copyFileSync(join(packageRoot, file), join(target, file));
	for (const directory of ["dist", "docs"]) {
		symlinkSync(join(packageRoot, directory), join(target, directory), "junction");
	}
}

/** A JSONL session of `turns` turns of four entries (prompt, tool call, tool result, answer), in format 4. */
export function writeLargeSession(directory: string, cwd: string, id: string, turns: number): void {
	mkdirSync(directory, { recursive: true });
	const lines = [JSON.stringify({ type: "session", version: 4, id, createdAt: new Date(0).toISOString(), cwd })];
	const usage = {
		input: 100,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 200,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistant = { api: "openai-completions", provider: PROVIDER, model: MODEL, usage };
	let parentId: string | null = null;
	let entry = 0;
	const append = (message: Record<string, unknown>) => {
		const entryId = (entry++).toString(16).padStart(8, "0");
		const timestamp = 1_700_000_000_000 + entry * 1_000;
		lines.push(
			JSON.stringify({
				type: "message",
				id: entryId,
				parentId,
				timestamp: new Date(timestamp).toISOString(),
				message: { ...message, timestamp },
			}),
		);
		parentId = entryId;
	};
	for (let turn = 0; turn < turns; turn++) {
		const callId = `call_${turn}`;
		append({
			role: "user",
			content: [{ type: "text", text: `Turn ${turn}: check the loader handles case ${turn}.` }],
		});
		append({
			role: "assistant",
			...assistant,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `npm test -- case-${turn}` } }],
		});
		append({
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: `PASS case-${turn}\n${"ok ".repeat(40)}\nTests: 148 passed` }],
		});
		append({
			role: "assistant",
			...assistant,
			stopReason: "stop",
			content: [{ type: "text", text: longMarkdown(1) }],
		});
	}
	writeFileSync(join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${lines.join("\n")}\n`);
}

export type ProcessRole = "host" | "engine";
export type Phase = "startup" | "session" | "shutdown";

/** A `delay` record of the event-loop diagnostic. */
export interface DelayRecord {
	readonly type: "delay";
	readonly role: ProcessRole;
	readonly pid: number;
	readonly at: string;
	readonly phase: Phase;
	readonly durationMs: number;
	readonly ticks: number;
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
}

/** A `block` record of the event-loop diagnostic. */
export interface BlockRecord {
	readonly type: "block";
	readonly role: ProcessRole;
	readonly at: string;
	readonly durationMs: number;
	readonly samples: number;
	readonly hotFrames: readonly { readonly count: number; readonly frame: string }[];
	readonly stacks: readonly { readonly count: number; readonly frames: readonly string[] }[];
}

export type LogRecord =
	| DelayRecord
	| BlockRecord
	| { readonly type: "start"; readonly role: ProcessRole; readonly pid: number };

export function readRecords(path: string): LogRecord[] {
	if (!fileExistsSync(path)) return [];
	return readTextSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as LogRecord);
}

export function delayOf(records: readonly LogRecord[], role: ProcessRole, phase: Phase): DelayRecord | undefined {
	return records.find(
		(record): record is DelayRecord => record.type === "delay" && record.role === role && record.phase === phase,
	);
}

/** A block record as a failure message shows it: where it was, how long, and the frames that held the loop. */
export function describeBlock(block: BlockRecord): string {
	const stack = block.stacks[0]?.frames ?? [];
	const frames = [...block.hotFrames.slice(0, 5).map((hot) => `${hot.count}/${block.samples} ${hot.frame}`)];
	const outer = stack.slice(-6).map((frame) => `outer ${frame}`);
	return [`${block.role} block at ${block.at}: ${block.durationMs} ms`, ...frames, ...outer].join("\n    ");
}

/**
 * The module path a frame names as it appears in both the sources and the built package: `core/tools/x` for
 * `packages/coding-agent/src/core/tools/x.ts` and for `.../dist/core/tools/x.js`, `builtin/intercom/broker/y` for
 * `packages/intercom/broker/y.ts` and its copy under `dist/builtin/intercom/`.
 */
const SHIP_SHARD_PATH = "packages/workflows/src/workers/ship-shard";
const NODE_SQLITE_PATH = "packages/coding-agent/src/core/storage/node-sqlite";

const SHIP_SHARD_FUNCTIONS: ReadonlySet<string> = new Set([
	"holdsNothingSync",
	"onlyConnectionSync",
	"shardOwnerSync",
	"removeConfirmedShard",
	"removeUnchanged",
	"retireEndedShipShards",
	"holdsNothing",
	"shardOwner",
	"inspectShard",
	"idleShard",
	"underJournalLock",
	"removeShardFiles",
	"shipJournalDirectory",
	"shipRootFile",
	"shipShardPath",
	"shipEventOf",
	"shipBatchId",
	"shipDigest",
]);

const NODE_SQLITE_DEFAULT_SELECTORS = [
	"databaseNow",
	"NodeSqliteDatabase.tryBegin/this.driver()",
	"NodeSqliteDatabase.dataVersion/this.driver()",
	"NodeSqliteDatabase.createExecutor/statement",
	"NodeSqliteDatabase.createExecutor/<returned>.exec/execute()",
	"NodeSqliteDatabase.createExecutor/<returned>.run/execute()",
	"NodeSqliteDatabase.createExecutor/<returned>.get/execute()",
	"NodeSqliteDatabase.createExecutor/<returned>.all/execute()",
	"NodeSqliteDatabase.close/this.tail.then()/this.driver()",
	"openConnection",
	"openNodeSqliteDatabase",
	"openNodeSqliteDatabase/switchToWriteAheadLog()",
] as const;

const WORKFLOW_BUNDLE_TAILS = [
	"builtin/workflows/src/extension/index.bundle",
	"builtin/workflows/src/extension/local-worker-entry",
	"builtin/workflows/src/index",
] as const;

function modulePathTails(path: string): string[] {
	const normalized = path.replaceAll("\\", "/").replace(/\.(?:[cm]?[jt]s)$/, "");
	if (normalized.startsWith("packages/coding-agent/src/")) {
		return [normalized.slice("packages/coding-agent/src/".length)];
	}
	const match = /^packages\/([^/]+)\/(.+)$/.exec(normalized);
	if (!match) return [normalized];
	const [, pkg, rest] = match;
	return [`${pkg}/${rest}`, `builtin/${pkg}/${rest.replace(/^src\//, "")}`];
}

function selectorRuntimeNames(selectorName: string): string[] {
	const parts = selectorName.split("/");
	const names = new Set<string>();
	const definitions = parts.filter((part) => !part.endsWith("()"));
	const leaf = definitions.at(-1);
	if (leaf !== undefined) {
		if (leaf.startsWith("<returned>.")) {
			names.add(leaf.slice("<returned>.".length));
		} else {
			names.add(leaf);
			const dot = leaf.lastIndexOf(".");
			if (dot !== -1 && leaf !== "NodeSqliteDatabase.close") {
				names.add(leaf.slice(dot + 1));
			}
		}
	}
	for (const part of parts) {
		if (!part.endsWith("()")) continue;
		const call = part.slice(0, -2);
		const callee = call.slice(call.lastIndexOf(".") + 1);
		if (callee !== "then" && callee !== "catch" && callee !== "finally") {
			names.add(callee);
		}
	}
	if (selectorName.startsWith("NodeSqliteDatabase.close/")) {
		names.add("finalizeReleasedStatements");
	}
	return [...names];
}

interface ParsedFrame {
	readonly fn: string;
	readonly url: string;
}

function parseFrame(frame: string): ParsedFrame | undefined {
	const trimmed = frame.trim();
	if (trimmed.startsWith("… ")) return undefined;
	const split = trimmed.lastIndexOf(" ");
	if (split <= 0) return undefined;
	const fn = trimmed.slice(0, split).trim();
	const raw = trimmed.slice(split + 1).trim();
	const location = (raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw).replaceAll("\\", "/");
	const lineMatch = /^(.*?):\d+(?::\d+)?$/.exec(location);
	const url = lineMatch ? lineMatch[1]! : location;
	return { fn, url };
}

const isAnonymousFn = (fn: string) => fn === "(anonymous)" || fn === "<anonymous>";

function hotApplicationFrame(
	frames: readonly string[],
): { readonly url: string; readonly fns: readonly string[] } | undefined {
	const parsed: ParsedFrame[] = [];
	for (const raw of frames) {
		if (raw.trim().startsWith("… ")) continue;
		const frame = parseFrame(raw);
		if (frame === undefined) return undefined;
		if (frame.url.startsWith("node:")) continue;
		if (!/[\\/]/.test(frame.url)) return undefined;
		parsed.push(frame);
	}
	const hot = parsed[0];
	if (hot === undefined) return undefined;
	if (!isAnonymousFn(hot.fn)) return { url: hot.url, fns: [hot.fn] };
	const callers: string[] = [];
	for (const caller of parsed.slice(1, 3)) {
		if (caller.url === hot.url && !isAnonymousFn(caller.fn)) callers.push(caller.fn);
	}
	return { url: hot.url, fns: callers };
}

const urlMatchesTail = (url: string, tail: string) => url.includes(tail.endsWith("/") ? tail : `${tail}.`);

/**
 * The open change that owns the code a block spent its samples in, when every hot frame it names lies in one such
 * change's area (scripts/event-loop/policy.ts, OWNED_ELSEWHERE); undefined when any of the block is this code's own.
 */
export function blockOwner(
	block: BlockRecord,
	areas: readonly {
		readonly owner: string;
		readonly paths?: readonly string[];
		readonly functions?: readonly { readonly file: string; readonly name: string }[];
	}[],
): string | undefined {
	const compiled = areas.map((area) => {
		const rawPaths = area.paths ?? [];
		const plainPaths = rawPaths.filter((path) => {
			const norm = path.replaceAll("\\", "/").replace(/\.(?:[cm]?[jt]s)$/, "");
			return norm !== NODE_SQLITE_PATH;
		});
		const hasShipShard = rawPaths.some(
			(path) => path.replaceAll("\\", "/").replace(/\.(?:[cm]?[jt]s)$/, "") === SHIP_SHARD_PATH,
		);
		const functionSelectors = [
			...(area.functions ?? []),
			...(rawPaths.some((path) => path.replaceAll("\\", "/").replace(/\.(?:[cm]?[jt]s)$/, "") === NODE_SQLITE_PATH)
				? NODE_SQLITE_DEFAULT_SELECTORS.map((name) => ({ file: `${NODE_SQLITE_PATH}.ts`, name }))
				: []),
		];
		const byFile = new Map<string, Set<string>>();
		for (const selector of functionSelectors) {
			let set = byFile.get(selector.file);
			if (!set) {
				set = new Set();
				byFile.set(selector.file, set);
			}
			for (const fn of selectorRuntimeNames(selector.name)) set.add(fn);
		}
		return {
			owner: area.owner,
			tails: plainPaths.flatMap(modulePathTails),
			hasShipShard,
			functions: [...byFile.entries()].map(([file, names]) => ({ tails: modulePathTails(file), names })),
		};
	});
	const ownerOfStack = (frames: readonly string[]): string | undefined => {
		const hot = hotApplicationFrame(frames);
		if (hot === undefined || hot.fns.length === 0) return undefined;
		for (const area of compiled) {
			if (area.tails.some((tail) => urlMatchesTail(hot.url, tail))) return area.owner;
			if (
				area.hasShipShard &&
				WORKFLOW_BUNDLE_TAILS.some((tail) => urlMatchesTail(hot.url, tail)) &&
				hot.fns.some((fn) => SHIP_SHARD_FUNCTIONS.has(fn))
			) {
				return area.owner;
			}
			for (const entry of area.functions) {
				if (
					entry.tails.some((tail) => urlMatchesTail(hot.url, tail)) &&
					hot.fns.some(
						(fn) =>
							entry.names.has(fn) ||
							(fn !== "close" && !fn.endsWith(".close") && entry.names.has(fn.slice(fn.lastIndexOf(".") + 1))),
					)
				) {
					return area.owner;
				}
			}
		}
		return undefined;
	};
	const owners = new Set<string | undefined>();
	for (const stack of block.stacks) owners.add(ownerOfStack(stack.frames));
	if (block.hotFrames.length > 0) owners.add(ownerOfStack(block.hotFrames.map((hot) => hot.frame)));
	if (owners.size !== 1) return undefined;
	return [...owners][0];
}
