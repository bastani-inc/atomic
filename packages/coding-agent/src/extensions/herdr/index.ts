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
import { getLoadedFileExtensionPaths } from "../../core/extensions/loaded-extension-paths.ts";
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
import { getActiveUserBlockLabel, getOpenUserBlocks } from "../../core/extensions/user-blocks.ts";
import { HerdrReporter } from "./reporter.ts";
import { createSocketTransport, resolveSocketEndpoint } from "./transport.ts";
import type { HerdrEnv } from "./types.ts";

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

/** Short error text for a turn whose final assistant message failed. */
export function turnFailureMessage(event: AgentEndEvent): string | undefined {
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (message === undefined || message.role !== "assistant") continue;
		if (message.stopReason !== "error") return undefined;
		return message.errorMessage && message.errorMessage.length > 0 ? message.errorMessage : "Agent turn failed";
	}
	return undefined;
}

export default function herdrExtension(pi: HerdrExtensionApi): void {
	const env = readHerdrEnv();
	if (!env) return;
	if (fileIntegrationLoaded(getLoadedFileExtensionPaths())) return;

	const reporter = new HerdrReporter({ paneId: env.paneId, transport: createSocketTransport(env.socketEndpoint) });

	/**
	 * Activation state.
	 *
	 * `pending` means the reporter has not yet seen a lifecycle event proving
	 * this is a TUI session; `standDown` means a file-based integration owns the
	 * pane and this instance must never write.
	 */
	let activation: "pending" | "active" | "stand-down" = "pending";

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
	 */
	async function ensureActivated(ctx: ExtensionContext): Promise<boolean> {
		if (activation === "stand-down") return false;
		if (ctx.mode !== "tui") return false;
		if (activation === "active") return true;
		if (fileIntegrationLoaded(getLoadedFileExtensionPaths())) {
			activation = "stand-down";
			return false;
		}
		activation = "active";
		await reporter.onSessionStart(ctx.sessionManager, ctx.isIdle(), {
			openBlocks: getOpenUserBlocks().length,
			activeLabel: getActiveUserBlockLabel(),
		});
		return true;
	}

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await ensureActivated(ctx);
	});

	pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
		// A first activation here already seeded `working` from ctx.isIdle().
		if (!(await ensureActivated(ctx))) return;
		reporter.onAgentStart(ctx.sessionManager);
	});

	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		if (!(await ensureActivated(ctx))) return;
		reporter.onAgentEnd(ctx.sessionManager, turnFailureMessage(event));
	});

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		if (!(await ensureActivated(ctx))) return;
		reporter.onAgentSettled(ctx.sessionManager, ctx.isIdle());
	});

	pi.on("agent_blocked", async (event, ctx: ExtensionContext) => {
		// A block can be the first event a deferred extension sees, and activation
		// seeds from the registry snapshot, so this event is already reflected.
		if (!(await ensureActivated(ctx))) return;
		reporter.onBlockOpened(event.openBlocks, event.activeLabel);
	});

	pi.on("agent_unblocked", async (event, ctx: ExtensionContext) => {
		if (!(await ensureActivated(ctx))) return;
		reporter.onBlockReleased(event.openBlocks, event.activeLabel);
	});

	pi.on("session_shutdown", async (event) => {
		if (activation !== "active") return;
		await reporter.onSessionShutdown(event.reason);
	});
}
