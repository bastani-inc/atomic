import type { DetachedToolResult } from "@bastani/atomic";
import type { StageWaitKind } from "./authoring-contract-stage.js";
import { StageWakeError } from "./stage-wait-errors.js";

/**
 * Every message that can wake a stage, by kind. Open for extension: a module that wakes stages adds its kind by
 * augmenting `@bastani/atomic/workflows` (in this repository too: kinds the runtime itself sends are declared here
 * instead). Never augment this source module: TypeScript then drops the augmentations of the public entry in the same
 * program. Register the kind with {@link registerStageWakeKind}, then send messages of it with
 * `deliverStageWake(runId, stageId, wake)`.
 *
 * ```ts
 * declare module "@bastani/atomic/workflows" {
 *   interface StageWakeKinds {
 *     "compaction-ready": { readonly summaryEntryId: string };
 *   }
 * }
 * ```
 */
export interface StageWakeKinds {
	/** Every detached tool call the stage waits on has a result. */
	"tool-results": { readonly results: readonly DetachedToolResult[] };
}

/** A message that wakes a waiting stage: one of the {@link StageWakeKinds}. */
export type StageWake = {
	[Kind in keyof StageWakeKinds]: { readonly kind: Kind } & StageWakeKinds[Kind];
}[keyof StageWakeKinds];

/** The kinds the runtime itself sends. They only wake a stage that waits for them and take no handler. */
export type BuiltinStageWakeKind = "tool-results";

/** What a {@link StageWakeHandler} learns about the stage it runs for. */
export interface StageWakeHandlerContext {
	readonly runId: string;
	readonly stageId: string;
	/** What the stage waits on while the handler runs, with its session released; `undefined` while it runs. */
	readonly waiting: StageWaitKind | undefined;
	/** The run's abort signal. Stop the handler's work when it aborts. */
	readonly signal: AbortSignal | undefined;
}

/**
 * Handles a message of one kind that arrives while its stage does not wait for that kind. It runs inside the stage's
 * FIFO: the stage takes no other message until the handler settles. A handler that throws or rejects is reported once
 * and does not fail the stage.
 */
export type StageWakeHandler<Kind extends keyof StageWakeKinds = keyof StageWakeKinds> = (
	wake: Extract<StageWake, { readonly kind: Kind }>,
	context: StageWakeHandlerContext,
) => void | Promise<void>;

/**
 * What became of a delivered message.
 * - `delivered`: it ended the stage's wait for its kind.
 * - `handled`: its kind's handler started for it.
 * - `queued`: it waits in the stage's mailbox, behind an earlier message or for the stage's next wait of its kind. A
 *   message still queued when the stage ends is reported once.
 * - `stage-not-open`: the run is live in this process, but the stage has not started or has ended. Nothing was queued.
 * - `run-not-live`: no run with this id runs in this process. Nothing was queued.
 */
export type StageWakeDelivery = {
	readonly status: "delivered" | "handled" | "queued" | "stage-not-open" | "run-not-live";
};

/** One registration of a kind; the newest registration of a kind is the one in effect. */
interface StageWakeRegistration {
	readonly handler: StageWakeHandler | undefined;
}

const BUILTIN_KINDS: ReadonlySet<string> = new Set<BuiltinStageWakeKind>(["tool-results"]);

// Shared across module copies: an SDK host's import may register a kind for runs started by the extension bundle.
const registrationsKey = Symbol.for("atomic-workflows/stage-wake-kinds@1");
const processState = globalThis as typeof globalThis & Record<symbol, Map<string, StageWakeRegistration[]> | undefined>;
const registrations: Map<string, StageWakeRegistration[]> = processState[registrationsKey] ?? new Map();
processState[registrationsKey] = registrations;

/** How a rejected argument reads in an error: a string quoted, anything else by its type. */
function describeArgument(value: string | object | number | boolean | bigint | symbol | null | undefined): string {
	if (typeof value === "string") return JSON.stringify(value);
	return value === null ? "null" : typeof value;
}

/**
 * Register a wake kind in this process. Without a handler, messages of the kind queue for the stage's next wait of
 * that kind. With a handler, a message that arrives while its stage does not wait for that kind runs the handler.
 * Registering a kind again puts the new registration in effect until it is removed. Returns a function that removes
 * this registration; the kind stays registered while another registration of it remains.
 *
 * Throws `StageWakeError` before registering anything: `invalid-wake-kind` for a kind that is not a non-empty string,
 * `invalid-wake-handler` for a handler that is not a function, and `builtin-kind-handler` for a handler given to a
 * built-in kind.
 */
export function registerStageWakeKind<Kind extends keyof StageWakeKinds>(
	kind: Kind,
	handler?: Kind extends BuiltinStageWakeKind ? never : StageWakeHandler<Kind>,
): () => void {
	// Both arguments come from JavaScript callers as well, whose values the types do not bind.
	const kindArgument = kind as string | object | number | boolean | bigint | symbol | null | undefined;
	const handlerArgument = handler as StageWakeHandler | string | object | number | boolean | null | undefined;
	if (typeof kindArgument !== "string" || kindArgument.length === 0)
		throw new StageWakeError(
			{ source: "sdk", field: "kind", value: describeArgument(kindArgument) },
			{ code: "invalid-wake-kind" },
		);
	if (handlerArgument !== undefined && typeof handlerArgument !== "function")
		throw new StageWakeError(
			{ source: "sdk", field: "handler", kind, value: describeArgument(handlerArgument) },
			{ code: "invalid-wake-handler" },
		);
	if (BUILTIN_KINDS.has(kind) && handlerArgument !== undefined)
		throw new StageWakeError({ source: "sdk", field: "handler", kind }, { code: "builtin-kind-handler" });
	const registration: StageWakeRegistration = { handler: handler as StageWakeHandler | undefined };
	const list = registrations.get(kind) ?? [];
	list.push(registration);
	registrations.set(kind, list);
	return () => {
		const current = registrations.get(kind);
		const index = current?.indexOf(registration) ?? -1;
		if (current === undefined || index < 0) return;
		current.splice(index, 1);
		if (current.length === 0) registrations.delete(kind);
	};
}

/** Whether any module registered `kind` in this process; built-in kinds always are. */
export function isStageWakeKindRegistered(kind: string): boolean {
	return BUILTIN_KINDS.has(kind) || registrations.has(kind);
}

/** The handler in effect for `kind`, if its newest registration has one. Built-in kinds never have one. */
export function stageWakeHandler(kind: string): StageWakeHandler | undefined {
	return registrations.get(kind)?.at(-1)?.handler;
}
