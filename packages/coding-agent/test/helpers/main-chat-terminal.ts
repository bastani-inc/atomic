import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { Settings } from "../../src/core/settings-manager.js";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.js";
import { createHarness, getMessageText } from "../suite/harness.js";
import { createEngineHostPair, type EngineHostPair } from "./in-process-engine-pair.js";

/**
 * The real interactive mode on a terminal, on either host, with a model whose first turn holds in a tool call until
 * released; every later request is answered. For tests that compare the main chat's frames and requests with those
 * origin/main recorded: what varies between runs and checkouts is masked, nothing else.
 */

export const ALT_ENTER = "\x1b\r";
export const ALT_UP = "\x1b[1;3A";
export const ESCAPE = "\x1b";
export const CTRL_C = "\x03";
/**
 * The frames were recorded on Linux. Windows draws other ones by design (its tool list adds powershell, its default
 * keys differ: alt+q takes the queue back), so the frame comparisons run where they were recorded; the rig-level
 * differential (single-screen-main-differential) runs everywhere.
 */
export const RECORDED_ON_OTHER_PLATFORM = process.platform === "win32";

/** This checkout's root, which a request's messages can name by absolute path. */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
/**
 * Below 80 columns the startup banner always stacks its text under the mark; wider, it puts it beside the mark only when
 * the session's folder (a temp dir, its length varying by machine) fits.
 */
const COLUMNS = 79;
const ROWS = 30;

export interface Gate {
	readonly entered: PromiseWithResolvers<void>;
	readonly release: PromiseWithResolvers<void>;
}

/** A tool that runs until `gate` opens, or stops at once when the run is interrupted, as a shell command does. */
function holdTool(gate: Gate): AgentTool {
	return {
		name: "hold",
		label: "Hold",
		description: "Holds the run open until released",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			gate.entered.resolve();
			const aborted = new Promise<"aborted">((resolve) => {
				if (signal?.aborted) resolve("aborted");
				signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
			});
			const outcome = await Promise.race([gate.release.promise.then(() => "held" as const), aborted]);
			return { content: [{ type: "text", text: outcome }], details: {} };
		},
	};
}

/**
 * What varies between runs and checkouts: elapsed times (and whether a running tool shows one yet), absolute paths
 * (temp dirs, the footer's folder and branch), and the usage row's token figures, which count the system prompt and
 * so this checkout's path. Requests are compared in full instead (`requestDigest`).
 */
export function normalizedFrame(lines: readonly string[]): string[] {
	return lines.map((line) => {
		const masked = line
			.replace(/\b\d+(\.\d+)?(ms|s|m)\b/g, "N$2")
			// A running tool's header shows its elapsed time only once it has run for a while.
			.replace(/^( *\S .*\)) · N(ms|s|m)$/, "$1")
			// A folder under the home directory is shown from `~`, as on a runner whose checkout is there; its shorter
			// path leaves room for the branch, which may be cut short.
			.replace(/~?(\/[^\s/·()]+){2,}\/?( \([^)·\s]*\)?)?/g, "<path>")
			.trimEnd();
		return /%\/\d+k \(auto\)$/.test(masked) ? masked.replace(/\d+(\.\d+)?k?/g, "n") : masked;
	});
}

type FauxContext = Parameters<Extract<FauxResponseStep, (...args: never[]) => unknown>>[0];

/**
 * A request as the model receives it: its tools and every message, with this checkout's root, temp dirs and tool call
 * ids masked. The system prompt is left out: it is built before the screen exists and names the machine (folders,
 * shell, date); the harness's diff.sh compares whole request bodies, system prompt included, against an origin/main build.
 */
function requestDigest(context: FauxContext): string {
	const masked = (text: string) => text.split(ROOT).join("<root>").split(tmpdir()).join("<tmp>");
	const body = JSON.stringify({
		tools: (context.tools ?? []).map((tool) => tool.name),
		messages: context.messages.map((message) => ({
			role: message.role,
			content: masked(JSON.stringify(message.content)).replace(/"id":"[^"]*"/g, '"id":"<id>"'),
		})),
	});
	return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export interface MainChatTerminal {
	readonly mode: InteractiveMode;
	readonly terminal: VirtualTerminal;
	/** The isolated host's engine pair; undefined in process. */
	readonly pair: EngineHostPair | undefined;
	readonly gate: Gate;
	/** Each request's tail after the model's last message, and its digest. */
	readonly requests: string[];
	readonly frames: Record<string, string[]>;
	/** The screen now, masked. */
	screen(): Promise<string[]>;
	/** Wait until the screen shows `pattern` and stops changing; answers it. */
	settled(pattern?: RegExp): Promise<string[]>;
	/** `settled`, recorded as frame `name`. */
	frame(name: string, pattern?: RegExp): Promise<void>;
	press(keys: string): void;
	stop(): Promise<void>;
}

/**
 * Start the interactive mode on `host`. `beforeRun` runs on the mode before its `init()`, as a test seam (for example
 * to give the agent view switcher its port opener).
 */
export async function startMainChat(
	host: "in-process" | "isolated",
	options: {
		readonly beforeRun?: (mode: InteractiveMode) => Promise<void> | void;
		/** On the isolated host, the engine draws its own UI, such as `/tasks`. */
		readonly engineUi?: boolean;
		/** Extensions of the session the chat steers (the engine's, on the isolated host). */
		readonly extensions?: ExtensionFactory[];
		/** Settings of the session the chat steers, such as how many queued messages a turn takes. */
		readonly settings?: Partial<Settings>;
		/** On the isolated host, whether the engine tells the host which queued messages it is delivering (default). */
		readonly queuedDeliveries?: boolean;
	} = {},
): Promise<MainChatTerminal> {
	const stops: Array<() => Promise<void> | void> = [];
	const gate: Gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
	stops.push(() => gate.release.resolve());
	const tools = [holdTool(gate)];
	let runtime: AgentSessionRuntime;
	let pair: EngineHostPair | undefined;
	let setResponses: (responses: FauxResponseStep[]) => void;
	if (host === "isolated") {
		const created = await createEngineHostPair({
			tools,
			engineUi: options.engineUi,
			engineExtensions: options.extensions,
			settings: options.settings,
			queuedDeliveries: options.queuedDeliveries,
		});
		pair = created;
		stops.push(() => created.cleanup());
		runtime = created.runtime;
		setResponses = (responses) => created.engine.setResponses(responses);
	} else {
		const harness = await createHarness({
			tools,
			extensionFactories: options.extensions,
			settings: options.settings,
		});
		stops.push(() => harness.cleanup());
		runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.session.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			} as never,
			async () => {
				throw new Error("no session replacement in this test");
			},
		);
		setResponses = (responses) => harness.setResponses(responses);
	}
	const requests: string[] = [];
	const answer =
		(reply: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
		(context) => {
			const lastAssistant = context.messages.findLastIndex((message) => message.role === "assistant");
			const tail = context.messages
				.slice(lastAssistant + 1)
				.map((message) => `${message.role}:${getMessageText(message)}`)
				.join(" + ");
			requests.push(`${tail} | ${requestDigest(context)}`);
			return reply;
		};
	setResponses([
		answer(fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })),
		...Array.from({ length: 6 }, (_, index) => answer(fauxAssistantMessage(`answer ${index + 2}`))),
	]);
	// The working line's verb is the one random part of a frame; the glyph's animation the one that moves by itself.
	const random = vi.spyOn(Math, "random").mockReturnValue(0);
	stops.push(() => random.mockRestore());
	// Offline: nothing is fetched while the chat starts.
	for (const [name, value] of [
		["ATOMIC_REDUCED_MOTION", "1"],
		["ATOMIC_OFFLINE", "1"],
	] as const) {
		const previous = process.env[name];
		process.env[name] = value;
		stops.push(() => {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		});
	}
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const mode = new InteractiveMode(runtime, { terminal });
	stops.push(() => mode.stop());
	// Whether fd and rg are installed on the machine would add a notice to the chat (a download, or "not found").
	mode.ensureManagedToolsReady = async () => {};
	await options.beforeRun?.(mode);
	void mode.run().catch(() => {});
	await vi.waitFor(
		() => {
			if (!mode.isInitialized) throw new Error("the interactive mode is still starting");
		},
		{ timeout: 30_000 },
	);
	const frames: Record<string, string[]> = {};
	const screen = async () => normalizedFrame(await terminal.flushAndGetViewport());
	const settled = async (pattern?: RegExp) => {
		let last: string[] = [];
		let stableSince = Date.now();
		await vi.waitFor(
			async () => {
				const now = await screen();
				if (now.join("\n") !== last.join("\n")) {
					last = now;
					stableSince = Date.now();
				}
				if (pattern && !pattern.test(now.join("\n"))) throw new Error(`no ${pattern} yet:\n${now.join("\n")}`);
				if (Date.now() - stableSince < 300) throw new Error("the screen is still changing");
			},
			{ timeout: 20_000, interval: 50 },
		);
		return last;
	};
	return {
		mode,
		terminal,
		pair,
		gate,
		requests,
		frames,
		screen,
		settled,
		async frame(name, pattern) {
			frames[name] = await settled(pattern);
		},
		press(keys) {
			terminal.sendInput(keys);
		},
		async stop() {
			for (const stop of stops.splice(0).reverse()) await stop();
		},
	};
}

/**
 * Frames and requests recorded on origin/main, per test file: `record` is set when the file runs there with its
 * record variable, and then writes what each case drew.
 */
export class OriginRecording {
	private readonly cases: Record<string, { frames: Record<string, string[]>; requests: string[] }>;
	constructor(
		private readonly fixture: string,
		readonly record: boolean,
	) {
		this.cases = record || !existsSync(fixture) ? {} : JSON.parse(readFileSync(fixture, "utf8"));
	}

	matches(name: string, chat: Pick<MainChatTerminal, "frames" | "requests">): void {
		if (this.record) {
			this.cases[name] = { frames: chat.frames, requests: chat.requests };
			writeFileSync(this.fixture, `${JSON.stringify(this.cases, null, "\t")}\n`);
			return;
		}
		const origin = this.cases[name];
		assert.ok(origin, `${name}: nothing recorded on origin/main for this case`);
		for (const [frame, lines] of Object.entries(origin.frames))
			assert.deepEqual(chat.frames[frame], lines, `${name}: frame "${frame}" differs from origin/main`);
		assert.deepEqual(Object.keys(chat.frames), Object.keys(origin.frames));
		assert.deepEqual(chat.requests, origin.requests, `${name}: the model's requests differ from origin/main`);
	}
}
