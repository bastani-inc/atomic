import type { AgentTool } from "@bastani/atomic-agent-core";
import type { FauxResponseStep } from "@bastani/atomic-ai/compat";
import xterm from "@xterm/headless";
import { vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import type { ExtensionFactory } from "../../src/core/extensions/index.js";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.js";
import { createHarness } from "../suite/harness.js";
import { createEngineHostPair, type EngineHostPair } from "./in-process-engine-pair.js";

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

/**
 * A terminal that keeps every write, so a test can replay them and see each screen the user could have seen: the state
 * after each synchronized update ends, and after each write outside one.
 */
export class FrameRecordingTerminal extends VirtualTerminal {
	private readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	/** A mark for `screensSince`: the writes so far. */
	mark(): number {
		return this.writes.length;
	}

	/** Every screen shown since `mark`, in order, replayed from the screen as it was at `mark`. */
	async screensSince(mark: number): Promise<string[][]> {
		const replay = new xterm.Terminal({ cols: this.columns, rows: this.rows, allowProposedApi: true });
		const write = (data: string) => new Promise<void>((resolve) => replay.write(data, resolve));
		const viewport = () => {
			const buffer = replay.buffer.active;
			const lines: string[] = [];
			for (let row = 0; row < replay.rows; row++)
				lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
			return lines;
		};
		await write(this.writes.slice(0, mark).join(""));
		const screens: string[][] = [];
		let synchronized = false;
		for (const data of this.writes.slice(mark)) {
			let rest = data;
			while (rest.length > 0) {
				if (synchronized) {
					const at = rest.indexOf(END_SYNC);
					const end = at === -1 ? rest.length : at + END_SYNC.length;
					await write(rest.slice(0, end));
					rest = rest.slice(end);
					if (at === -1) continue;
					synchronized = false;
					screens.push(viewport());
					continue;
				}
				const at = rest.indexOf(BEGIN_SYNC);
				const before = at === -1 ? rest : rest.slice(0, at);
				if (before.length > 0) {
					await write(before);
					screens.push(viewport());
				}
				if (at === -1) break;
				await write(BEGIN_SYNC);
				rest = rest.slice(at + BEGIN_SYNC.length);
				synchronized = true;
			}
		}
		replay.dispose();
		return screens;
	}
}

export interface RecordedChat {
	readonly mode: InteractiveMode;
	readonly terminal: FrameRecordingTerminal;
	/** The isolated host's engine pair; undefined in process. */
	readonly pair: EngineHostPair | undefined;
	/** Wait until the screen shows `pattern` and stops changing; answers it. */
	settled(pattern: RegExp): Promise<string[]>;
	/** Runs before the chat stops, ahead of everything else, for example to let a held run go on. */
	beforeStop(stop: () => void): void;
	stop(): Promise<void>;
}

/**
 * The real interactive mode on a terminal that records every frame, on either host, offline, with the model answering
 * `responses` and the session (the engine's, on the isolated host) loading `extensions`.
 */
export async function startRecordedChat(
	host: "in-process" | "isolated",
	options: { responses: FauxResponseStep[]; tools?: AgentTool[]; extensions?: ExtensionFactory[] },
): Promise<RecordedChat> {
	const stops: Array<() => Promise<void> | void> = [];
	const tools = options.tools ?? [];
	let runtime: AgentSessionRuntime;
	let pair: EngineHostPair | undefined;
	if (host === "isolated") {
		const created = await createEngineHostPair({ tools, engineExtensions: options.extensions });
		pair = created;
		stops.push(() => created.cleanup());
		created.engine.setResponses(options.responses);
		runtime = created.runtime;
	} else {
		const harness = await createHarness({ tools, extensionFactories: options.extensions });
		stops.push(() => harness.cleanup());
		harness.setResponses(options.responses);
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
	}
	// The working line's verb is the one random part of a frame; the glyph's animation the one that moves by itself.
	const random = vi.spyOn(Math, "random").mockReturnValue(0);
	stops.push(() => random.mockRestore());
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
	const terminal = new FrameRecordingTerminal(79, 30);
	const mode = new InteractiveMode(runtime, { terminal });
	stops.push(() => mode.stop());
	mode.ensureManagedToolsReady = async () => {};
	void mode.run().catch(() => {});
	await vi.waitFor(
		() => {
			if (!mode.isInitialized) throw new Error("the interactive mode is still starting");
		},
		{ timeout: 30_000 },
	);
	return {
		mode,
		terminal,
		pair,
		async settled(pattern) {
			let last = "";
			let stableSince = Date.now();
			let screen: string[] = [];
			await vi.waitFor(
				async () => {
					screen = await terminal.flushAndGetViewport();
					const text = screen.join("\n");
					if (text !== last) {
						last = text;
						stableSince = Date.now();
					}
					if (!pattern.test(text)) throw new Error(`no ${pattern} yet:\n${text}`);
					if (Date.now() - stableSince < 300) throw new Error("the screen is still changing");
				},
				{ timeout: 20_000, interval: 50 },
			);
			return screen;
		},
		beforeStop(stop) {
			stops.push(stop);
		},
		async stop() {
			for (const stop of stops.splice(0).reverse()) await stop();
		},
	};
}
