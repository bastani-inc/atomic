import { setImmediate as nextTurn } from "node:timers/promises";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import { type Static, Type } from "typebox";
import { graphemeHead } from "../../utils/terminal-text.ts";
import { MAX_COMMAND_TIMEOUT_SECONDS } from "../tasks/cancel-reason.js";
import type { TaskId, WaitOutcome, WaitPolicy } from "../tasks/contracts.js";
import { type TaskLease, TOOL_TASK_OUTPUT_MAX_BYTES, type WaitLease } from "../tasks/supervisor.js";
import { lookupOwnedTask, type SupervisedCommandOwner, validateBashWait } from "./bash-pty-native.js";
import type { createSearchPageDefinition, SearchToolOptions } from "./search.ts";
import type { SearchToolDetails } from "./search-details.ts";
import { TaskToolError } from "./shell-task-status.ts";
import { executeSupervisedToolTask } from "./tool-task.ts";

type PageTool = ReturnType<typeof createSearchPageDefinition>;
type Page = Awaited<ReturnType<PageTool["execute"]>>;
type PageInput = Static<PageTool["parameters"]>;
type LaunchInput = PageInput & { action?: never; id?: never; budgetMs?: never; wait?: WaitPolicy; timeout?: number };
type WaitInput = { action: "wait"; id: string; budgetMs?: number } & Partial<
	Record<keyof PageInput | "timeout" | "wait", never>
>;
const DEFAULT_TIMEOUT_SECONDS = 300;

export function historySearchSchema(page: PageTool["parameters"]) {
	return Type.Unsafe<LaunchInput | WaitInput>({
		...page,
		required: [],
		properties: {
			...page.properties,
			timeout: Type.Number({
				description: `Execution timeout for a history continuation task in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_COMMAND_TIMEOUT_SECONDS}).`,
			}),
			wait: Type.Object(
				{
					kind: Type.Union([Type.Literal("background"), Type.Literal("foreground")]),
					budgetMs: Type.Optional(Type.Number({ minimum: 0 })),
				},
				{
					additionalProperties: false,
					description:
						"Observation policy for a history continuation task. Omit to use the owner's automatic yield.",
				},
			),
			action: Type.Literal("wait", {
				description: "Observe an owned history search and read its next continuation page.",
			}),
			id: Type.String({ description: "Task ID for action wait." }),
			budgetMs: Type.Number({
				minimum: 0,
				description: "Observation budget for action wait; omitted uses the owner policy.",
			}),
		},
	});
}

export interface SearchTaskDetails extends SearchToolDetails {
	observation?: WaitOutcome;
	remainingPages?: number;
	/** URLs the task did not finish, exactly as the search supplied them. */
	continueWith?: readonly string[];
}

// Read only the budget notes on the *returned* page. A normal page end, skip hint, lookahead,
// match or context quoting a note is not a request for background work.
function budgetCursors(page: Page): string[] {
	const urls: string[] = [];
	for (const block of page.content) {
		if (block.type !== "text") continue;
		for (const line of block.text.split("\n")) {
			const row = /^(history:\/\/.+?)(?::(\d+): |-(\d+)- )(.*)$/.exec(line);
			if ((row?.[2] ?? row?.[3]) !== "0") continue;
			const note = /^\[.*\bthe (?:byte|row|time) budget ran out\b.*; continue with (history:\/\/[^\s]+?)\]$/.exec(
				row![4]!,
			);
			if (note) urls.push(note[1]!);
		}
	}
	return urls;
}

interface Delivery {
	pages: Page[];
	read: number;
	pending: string[];
}
// Capability lifetime is the owner's task retention lifetime, not the lifetime of a particular tool instance.
const deliveries = new WeakMap<TaskLease, Delivery>();

export async function runSearchWithTasks(
	page: PageTool,
	binding: SearchToolOptions["taskOwner"],
	cwd: string,
	id: string,
	input: LaunchInput | WaitInput,
	signal: AbortSignal | undefined,
	update: Parameters<PageTool["execute"]>[3],
	ctx: Parameters<PageTool["execute"]>[4],
): Promise<AgentToolResult<SearchTaskDetails | undefined>> {
	const owner = () => (typeof binding === "function" ? binding() : binding);
	if (input.action !== undefined) {
		if (
			input.action !== "wait" ||
			typeof input.id !== "string" ||
			Object.entries(input).some(([k, v]) => v !== undefined && !["action", "id", "budgetMs"].includes(k)) ||
			(input.budgetMs !== undefined && (!Number.isFinite(input.budgetMs) || input.budgetMs < 0))
		)
			throw new Error("Invalid search wait: expected action wait, id, and optional finite non-negative budgetMs");
		return waitForPage(owner(), input, signal);
	}
	if (typeof input.pattern !== "string" || input.id !== undefined || input.budgetMs !== undefined)
		throw new Error("Invalid search: a pattern is required; id and budgetMs require action wait");
	const { wait, timeout = DEFAULT_TIMEOUT_SECONDS, ...params } = input;
	const first = await page.execute(id, params, signal, update, ctx);
	if (!first.details?.scopePath?.split(", ").every((path) => path.startsWith("history://"))) return first;
	validateBashWait(wait);
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_COMMAND_TIMEOUT_SECONDS)
		throw new Error(`Invalid timeout: expected a positive number no greater than ${MAX_COMMAND_TIMEOUT_SECONDS}`);
	if (binding === undefined) return first;
	const pending = budgetCursors(first);
	if (!pending.length) return first;
	signal?.throwIfAborted();
	const bound = owner();
	if (!bound?.startToolTask) return first;
	const delivery: Delivery = { pages: [], read: 0, pending };
	const { skip: _skip, ...query } = params; // skip selected the original page; a cursor URL is a fresh ordinary search.
	const { observation } = await executeSupervisedToolTask(bound, {
		tool: "search",
		label: `search ${graphemeHead(params.pattern, 80)} in ${first.details.scopePath}`,
		cwd: ctx?.cwd ?? cwd,
		timeoutMs: timeout * 1000,
		...(wait && { wait }),
		...(signal && { signal }),
		onStarted: (lease) => deliveries.set(lease, delivery),
		async work(write, stop) {
			let retained = 0;
			while (pending.length) {
				await nextTurn();
				stop.throwIfAborted();
				const url = pending[0]!;
				const result = await page.execute(id, { ...query, paths: url }, stop, undefined, ctx);
				stop.throwIfAborted();
				const cost = Buffer.byteLength(JSON.stringify(result));
				if (retained + cost > TOOL_TASK_OUTPUT_MAX_BYTES) break; // Leave the entire unretained page's URL available.
				retained += cost;
				delivery.pages.push(result);
				for (const block of result.content) if (block.type === "text") write(`${block.text}\n`);
				const next = budgetCursors(result);
				pending.splice(0, 1, ...next);
				// No advancing cursor. The page and its exact retry URL remain available; don't poll a busy store.
				if (next.includes(url)) break;
			}
			return "finished";
		},
	});
	return { ...first, details: { ...first.details, observation } };
}

async function waitForPage(
	owner: SupervisedCommandOwner | undefined,
	input: WaitInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<SearchTaskDetails>> {
	signal?.throwIfAborted();
	if (!owner) throw new Error("Search task wait requires a supported task owner");
	const task = lookupOwnedTask(owner, input.id);
	const delivery = deliveries.get(task);
	if (!delivery)
		throw new TaskToolError({ code: "UnknownTask", message: "not a background search in this session" }, input.id);
	let lease: WaitLease | undefined;
	const abort = () => {
		if (lease) owner.supervisor.disposeTaskWait(lease);
	};
	const registered = (w: WaitLease) => {
		lease = w;
		if (signal?.aborted) abort();
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const id = input.id as TaskId;
		const observed = await (owner.waitForTask
			? owner.waitForTask(id, input.budgetMs, registered)
			: owner.supervisor.waitForTaskId(owner.owner, id, input.budgetMs, registered));
		signal?.throwIfAborted();
		if (!observed.ok) throw new TaskToolError(observed.error, id);
		const observation = observed.value;
		const page = delivery.pages[delivery.read];
		if (page) delivery.read++;
		const remainingPages = delivery.pages.length - delivery.read;
		const details = {
			...page?.details,
			observation,
			remainingPages,
			...(observation.kind === "settled" && delivery.pending.length ? { continueWith: [...delivery.pending] } : {}),
		};
		if (page) return { ...page, details };
		const status =
			observation.kind === "yielded"
				? "Search is still running."
				: observation.result.kind === "failed"
					? `Search failed: ${observation.result.message}`
					: observation.result.kind === "cancelled"
						? `Search stopped: ${observation.result.cause}`
						: "No more continuation pages.";
		return {
			content: [{ type: "text", text: status }],
			details,
			...(observation.kind === "settled" && observation.result.kind !== "completed" ? { isError: true } : {}),
		};
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
