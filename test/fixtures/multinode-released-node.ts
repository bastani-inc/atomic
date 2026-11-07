/**
 * One "node" of the released-session scenario (#4329, scenario 5), run as its own process with its own agent
 * directory, HOME and Atomic home, sharing only the session storage selected by ATOMIC_STORAGE.
 *
 *   release <json>  records a session that writes a file in `cwd`, releases it (it holds nothing in memory afterwards),
 *                   prints {"sessionId", "snapshots", "releasedCwd"}, then waits to be killed
 *   wake <json>     starts a runtime of its own, prints {"ready": true}, waits for the `go` file the test writes (so the
 *                   test can cut this node off from the database first), then brings the released session back with
 *                   `AgentSessionRuntime.rehydrate` and prints where it continues and what it reads there through the
 *                   path the releasing node wrote
 */
import { existsSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.ts";
import { selectProcessStorage } from "../../packages/coding-agent/src/core/storage/process-selection.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { emit, emitFailure, fauxNodeRuntime } from "./multinode-node-support.ts";

interface ReleaseArgs {
	readonly cwd: string;
	readonly file: string;
	readonly content: string;
}

interface WakeArgs {
	/** The directory this node's own runtime starts in; the released session's checkout is not here. */
	readonly cwd: string;
	readonly sessionId: string;
	/** The absolute path, on the releasing node, of the file the session wrote. */
	readonly readPath: string;
	/** The file whose appearance lets the wake begin, once the runtime is up. */
	readonly goFile: string;
}

async function release(args: ReleaseArgs): Promise<void> {
	const agentDir = getAgentDir();
	selectProcessStorage("sessions", agentDir, args.cwd);
	const store = await resolveSessionStore(args.cwd, { agentDir, settings: {} });
	const sessionManager = await SessionManager.create(store, args.cwd);
	const harness = await createHarness({ sessionManager, cwd: args.cwd });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: args.file, content: args.content })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(`wrote ${args.file}`),
	]);
	await harness.session.prompt("write the file");
	const released = await harness.session.release();
	emit({
		sessionId: released.sessionId,
		releasedCwd: released.cwd,
		snapshots: sessionManager.getLatestWorktreeSnapshots().size,
	});
	await new Promise(() => {});
}

async function wake(args: WakeArgs): Promise<void> {
	const agentDir = getAgentDir();
	selectProcessStorage("sessions", agentDir, args.cwd);
	const store = await resolveSessionStore(args.cwd, { agentDir, settings: {} });
	const { faux, model, modelRuntime } = await fauxNodeRuntime(agentDir);
	const runtime = await createAgentSessionRuntime(
		async (options) => {
			const services =
				options.services ??
				(await createAgentSessionServices({
					cwd: options.cwd,
					agentDir,
					modelRuntime,
					resourceLoaderOptions: { builtinPackagePaths: [], noSkills: true, noPromptTemplates: true, noThemes: true },
				}));
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				model,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd: args.cwd, agentDir, sessionManager: await SessionManager.create(store, args.cwd) },
	);
	emit({ ready: true });
	while (!existsSync(args.goFile)) await delay(20);
	const woken = await runtime.rehydrate(args.sessionId);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: args.readPath })], { stopReason: "toolUse" }),
		fauxAssistantMessage("continued"),
	]);
	await woken.prompt("read the file you wrote");
	const entries = woken.sessionManager.getEntries();
	const toolResult = entries
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.content] : [],
		)
		.at(-1);
	const cwd = woken.sessionManager.getCwd();
	emit({
		cwd: existsSync(cwd) ? realpathSync(cwd) : cwd,
		cwdExists: existsSync(cwd),
		mappings: woken.sessionManager.getWorktreeRootMappings(),
		userMessages: entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
		toolResult,
	});
	await runtime.dispose();
	await store.close();
}

const [command, json] = process.argv.slice(2);
try {
	if (command === "release") await release(JSON.parse(json!) as ReleaseArgs);
	else if (command === "wake") await wake(JSON.parse(json!) as WakeArgs);
	else throw new Error(`unknown command ${command}`);
	process.exit(0);
} catch (error) {
	emitFailure(error);
	process.exit(2);
}
