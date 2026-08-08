/**
 * Builtin Herdr pane reporter.
 *
 * Herdr is a terminal multiplexer that shows, per pane, whether the agent in it
 * is working, idle, or waiting on a person. This extension is the reporter for
 * that view: it reads Atomic's own lifecycle events and the user-decision block
 * door, and writes short state reports to the Herdr socket named in the pane's
 * environment.
 *
 * Outside a Herdr TUI pane it does nothing at all. It opens no socket, starts
 * no timer, and registers no listener unless `HERDR_ENV=1` arrives together
 * with `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`, and it stands down entirely
 * when a file-based `herdr-agent-state` integration loaded in the same cycle.
 */

import { basename } from "node:path";
import type { EventBus } from "../../core/event-bus.ts";
import {
	captureLoadedFileExtensionPathCycle,
	loadedFileExtensionPathsOf,
} from "../../core/extensions/loaded-extension-paths.js";
import type {
	AgentBlockedEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	AgentUnblockedEvent,
	ExtensionContext,
	ExtensionHandler,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../core/extensions/types.ts";
import { getActiveUserBlockLabel, getOpenUserBlocks } from "../../core/extensions/user-blocks.js";
import {
	getWorkflowLifecycleBridgeSnapshot,
	isWorkflowLifecycleBridgeEvent,
	WORKFLOW_LIFECYCLE_EVENT,
} from "../../core/workflow-lifecycle-events.js";
import { HerdrReporter } from "./reporter.js";
import { createSocketTransport, resolveSocketEndpoint } from "./transport.js";
import type { HerdrEnv } from "./types.js";

/**
 * The subset of `ExtensionAPI` this extension uses.
 *
 * Declaring it keeps the factory testable with a recording host while staying
 * assignable from the real `ExtensionAPI`, so nothing here needs a cast.
 */
export interface HerdrExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): void;
	events?: Pick<EventBus, "on">;
	on(event: "agent_blocked", handler: ExtensionHandler<AgentBlockedEvent>): void;
	on(event: "agent_unblocked", handler: ExtensionHandler<AgentUnblockedEvent>): void;
}

/** File-based Herdr integrations this builtin defers to. */
const FILE_INTEGRATION_BASENAMES = new Set(["herdr-agent-state.ts", "herdr-agent-state.js"]);

/**
 * Whether a file-based Herdr integration loaded in this cycle.
 *
 * Loaded, not present: a path on disk can be disabled, shadowed, or fail to
 * load, and standing down for one of those would leave the pane unreported.
 */
export function fileIntegrationLoaded(paths: readonly string[]): boolean {
	return paths.some((path) => FILE_INTEGRATION_BASENAMES.has(basename(path)));
}

/**
 * Read the pane environment.
 *
 * Read per factory invocation rather than at module load, because one process
 * can load sessions after the pane environment has changed.
 */
export function readHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const paneId = env.HERDR_PANE_ID;
	const socketPath = env.HERDR_SOCKET_PATH;
	if (!paneId || !socketPath) return undefined;
	return { paneId, socketEndpoint: resolveSocketEndpoint(socketPath) };
}

/**
 * The message reported when a turn's final assistant message failed.
 *
 * Deliberately fixed text, never the provider's own `errorMessage`. That field
 * is whatever a provider or a custom `streamSimple` implementation put there:
 * `error.message`, `String(error)`, a normalized response body, raw request
 * metadata. Real examples carry authorization headers and echoed prompt and
 * model output, and the privacy rule is that none of that reaches the socket.
 *
 * Redacting it is not a substitute. There is no typed error category to key on
 * — `stopReason` supplies only the broad `"error"` — and no pattern list can be
 * sound against arbitrary provider formats. The pane needs to know the turn
 * failed, which this says, and the transcript already has the detail.
 */
export const TURN_FAILURE_MESSAGE = "Agent turn failed";

export function turnFailureMessage(event: AgentEndEvent): string | undefined {
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (message === undefined || message.role !== "assistant") continue;
		return message.stopReason === "error" ? TURN_FAILURE_MESSAGE : undefined;
	}
	return undefined;
}

export default function herdrExtension(pi: HerdrExtensionApi): void {
	const env = readHerdrEnv();
	if (!env) return;
	// Captured, not re-read later from module scope. Loading yields between
	// inline factories and one process can run overlapping loaders, so a global
	// read at activation time could answer with a different cycle's file set —
	// and stand down for a cycle that has no file integration, or fail to stand
	// down for one that does.
	const loadCycle = captureLoadedFileExtensionPathCycle();
	if (fileIntegrationLoaded(loadedFileExtensionPathsOf(loadCycle))) return;

	const reporter = new HerdrReporter({ paneId: env.paneId, transport: createSocketTransport(env.socketEndpoint) });

	/**
	 * Activation state.
	 *
	 * `pending` means the reporter has not yet seen a lifecycle event proving
	 * this is a TUI session; `standDown` means a file-based integration owns the
	 * pane and this instance must never write.
	 */
	let activation: "pending" | "active" | "stand-down" = "pending";

	/** Latched at shutdown so a late detached callback cannot revive this instance. */
	let closed = false;

	/**
	 * Adopt this session on the first TUI lifecycle event, whichever it is.
	 *
	 * Extension loading can be deferred until after the first frame, so
	 * `session_start` may already have been emitted — to an extension set this
	 * one was not yet in — by the time it loads. Binding on any lifecycle event
	 * and seeding from the host makes the reporter correct whether it arrived
	 * before or after the turn it is describing.
	 *
	 * The block state is seeded from the registry's live snapshot rather than
	 * from replayed events. Events that fired before this extension loaded cannot
	 * be replayed at all, and the registry is module scope so a block can outlive
	 * the runner that was detached during a reload. Without the snapshot a pane
	 * with a dialog already open would report idle.
	 *
	 * The stand-down check runs again here, not only in the factory. File
	 * extensions load before inline factories today, but a deferred or lazily
	 * discovered `herdr-agent-state` could land after this one; re-reading the
	 * cycle's loaded paths at activation means the pane can never end up with two
	 * writers regardless of load order.
	 *
	 * This is synchronous on purpose, and must stay that way. The runner
	 * publishes block changes with a detached `emit`, so the open and close
	 * handlers for one dialog run concurrently. If activation could suspend, the
	 * first handler would wait through it while the second took the already-active
	 * fast path, and a block that opened and closed during activation would be
	 * reported in the wrong order — leaving the pane blocked with an empty
	 * registry. With no await anywhere on this path every concurrent handler runs
	 * to completion in arrival order.
	 */
	let unsubscribeWorkflowLifecycle: (() => void) | undefined;
	function ensureActivated(ctx: ExtensionContext): boolean {
		if (closed || activation === "stand-down") return false;
		if (ctx.mode !== "tui") return false;
		if (activation === "active") return true;
		if (fileIntegrationLoaded(loadedFileExtensionPathsOf(loadCycle))) {
			activation = "stand-down";
			return false;
		}
		activation = "active";
		const workflowSnapshot = pi.events === undefined ? [] : getWorkflowLifecycleBridgeSnapshot(pi.events);
		unsubscribeWorkflowLifecycle = pi.events?.on(WORKFLOW_LIFECYCLE_EVENT, (payload) => {
			if (typeof payload !== "object" || payload === null || !isWorkflowLifecycleBridgeEvent(payload)) return;
			reporter.onWorkflowLifecycle(payload);
		});
		reporter.seedWorkflowLifecycleEvents(workflowSnapshot);
		reporter.onSessionStart(ctx.sessionManager, ctx.isIdle(), {
			openBlocks: getOpenUserBlocks().length,
			activeLabel: getActiveUserBlockLabel(),
		});
		return true;
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		ensureActivated(ctx);
	});

	pi.on("agent_start", (_event, ctx: ExtensionContext) => {
		// A first activation here already seeded `working` from ctx.isIdle().
		if (!ensureActivated(ctx)) return;
		reporter.onAgentStart(ctx.sessionManager);
	});

	pi.on("agent_end", (event, ctx: ExtensionContext) => {
		if (!ensureActivated(ctx)) return;
		reporter.onAgentEnd(ctx.sessionManager, turnFailureMessage(event));
	});

	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		if (!ensureActivated(ctx)) return;
		reporter.onAgentSettled(ctx.sessionManager, ctx.isIdle());
	});

	/**
	 * Report the block door as it is *now*, ignoring the event's own counts.
	 *
	 * The runner publishes each block change with a detached `emit`, and each emit
	 * awaits its handlers. A slow handler registered by another extension for only
	 * one of the two events is enough to deliver them out of order, and the
	 * payload of a late `agent_blocked` still says one block is open. Acting on it
	 * pins the pane at `blocked` with an empty registry — a state nothing later
	 * corrects for an idle agent.
	 *
	 * The registry is mutated synchronously before subscribers run, so reading it
	 * here is always current. Branching on the live count rather than on which
	 * event arrived is the point: a late `agent_blocked` for an already-closed
	 * block correctly reports released.
	 */
	function reportLiveBlockState(): void {
		const openBlocks = getOpenUserBlocks().length;
		if (openBlocks > 0) reporter.onBlockOpened(openBlocks, getActiveUserBlockLabel() ?? "");
		else reporter.onBlockReleased(0, undefined);
	}

	pi.on("agent_blocked", (_event, ctx: ExtensionContext) => {
		// A block can be the first event a deferred extension sees, and activation
		// seeds from the registry snapshot, so this event is already reflected.
		if (!ensureActivated(ctx)) return;
		reportLiveBlockState();
	});

	pi.on("agent_unblocked", (_event, ctx: ExtensionContext) => {
		if (!ensureActivated(ctx)) return;
		reportLiveBlockState();
	});

	pi.on("session_shutdown", async (event) => {
		// Latched before anything else, so a detached block callback that lands
		// after teardown cannot activate an instance the session has finished
		// with. `_buildRuntime()` detaches the outgoing runner but cannot cancel
		// an emit already in flight.
		closed = true;
		unsubscribeWorkflowLifecycle?.();
		if (activation !== "active") return;
		await reporter.onSessionShutdown(event.reason);
	});
}
