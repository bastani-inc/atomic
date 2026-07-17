import type { Terminal } from "@earendil-works/pi-tui";
import { main } from "../../../packages/coding-agent/src/main.ts";
import type { InteractiveMode } from "../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { IsolatedInteractiveRuntime } from "../../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";

const CONTROL_PREFIX = "@@ATOMIC_TEST@@";

function report(value: Record<string, object | boolean | null | number | string | undefined>): void {
	process.stdout.write(`${CONTROL_PREFIX}${JSON.stringify(value)}\n`);
}

class RecordingTerminal implements Terminal {
	columns = 100;
	rows = 36;
	kittyProtocolActive = false;
	private onInput: ((data: string) => void) | undefined;
	private output = "";
	private renders = 0;

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
		report({ type: "terminal_ready", hostPid: process.pid });
	}
	stop(): void { this.onInput = undefined; }
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.renders += 1;
		this.output = `${this.output}${data}`.slice(-512 * 1024);
		report({ type: "render", renders: this.renders, output: this.output.slice(-32 * 1024) });
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	inject(data: string): void {
		report({ type: "input_received", data });
		this.onInput?.(data);
	}
	snapshot(mode: InteractiveMode | undefined): void {
		const runtime = mode?.runtimeHost;
		report({
			type: "state",
			hostPid: process.pid,
			renders: this.renders,
			output: this.output,
			enginePid: runtime instanceof IsolatedInteractiveRuntime ? runtime.getEnginePid() : undefined,
			generation: runtime instanceof IsolatedInteractiveRuntime ? runtime.getEngineGeneration() : undefined,
			sessionFile: mode?.session.sessionFile,
		});
	}
}

async function reportAutocomplete(mode: InteractiveMode | undefined, prefix: string): Promise<void> {
	const provider = mode?.autocompleteProvider;
	if (!provider) {
		report({ type: "autocomplete", prefix, items: null });
		return;
	}
	const controller = new AbortController();
	const suggestions = await provider.getSuggestions([prefix], 0, prefix.length, { signal: controller.signal });
	report({
		type: "autocomplete",
		prefix,
		items: (suggestions?.items ?? []).map((item) => ({ value: item.value, label: item.label })),
	});
}

async function runHost(): Promise<void> {
	const terminal = new RecordingTerminal();
	let mode: InteractiveMode | undefined;
	let buffer = "";
	const mutateSession = async (): Promise<void> => {
		if (!mode?.session.model || !(mode.runtimeHost instanceof IsolatedInteractiveRuntime)) return;
		await mode.session.setModel(mode.session.model);
		mode.session.setThinkingLevel(mode.session.thinkingLevel === "high" ? "low" : "high");
		mode.session.setSessionName("exactly-once");
		await mode.runtimeHost.synchronize();
		report({ type: "mutation_done", sessionFile: mode.session.sessionFile });
	};
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			try {
				const command = JSON.parse(line) as { type?: string; data?: string };
				if (command.type === "input" && typeof command.data === "string") terminal.inject(command.data);
				else if (command.type === "state") terminal.snapshot(mode);
				else if (command.type === "mutate") void mutateSession();
				else if (command.type === "autocomplete" && typeof command.data === "string") void reportAutocomplete(mode, command.data);
			} catch {}
		}
	});
	const heartbeat = setInterval(() => {
		const runtime = mode?.runtimeHost;
		report({
			type: "heartbeat",
			at: performance.now(),
			enginePid: runtime instanceof IsolatedInteractiveRuntime ? runtime.getEnginePid() : undefined,
			generation: runtime instanceof IsolatedInteractiveRuntime ? runtime.getEngineGeneration() : undefined,
			recovering: runtime instanceof IsolatedInteractiveRuntime ? runtime.isRecovering() : undefined,
			editorText: mode?.editor.getText(),
			streaming: mode?.session.isStreaming,
		});
	}, 10);
	try {
		await main(process.argv.slice(2), {
			internalInteractiveHarness: {
				forceInteractive: true,
				terminal,
				onMode: (created) => {
					mode = created;
					if (created.runtimeHost instanceof IsolatedInteractiveRuntime) {
						created.runtimeHost.onDiagnostic((diagnostic) => report({ type: "diagnostic", message: diagnostic.message }));
					}
					created.session.subscribe((event) => report({ type: "session_event", eventType: event.type }));
				},
			},
		});
	} finally {
		clearInterval(heartbeat);
	}
}

if (process.env.ATOMIC_INTERACTIVE_ENGINE_CHILD === "1") await main(process.argv.slice(2));
else await runHost();
