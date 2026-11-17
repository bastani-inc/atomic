import { Container, Text } from "@bastani/atomic-tui";
import { expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { renderEngineDiagnostic } from "../src/modes/interactive-engine/engine-diagnostic-view.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import { stripAnsi } from "../src/utils/ansi.js";

// Regression #2964, reproduced in tmux: ordinary status coalescing erased diagnostic messages.
test("keeps adjacent diagnostics and later status updates in the rendered transcript", () => {
	initTheme("dark");
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, { chatContainer: new Container(), ui: { requestRender: vi.fn() } });
	const status = mode.showStatus.bind(mode);
	const view = { showStatus: status, showError: vi.fn(), stopWorkingLoader: vi.fn() };
	for (const message of ["first diagnostic", "second diagnostic"]) {
		renderEngineDiagnostic({ activity: undefined, elapsedMs: 0, level: "blocking", source: "stderr", message }, view);
	}
	status("old ordinary status");
	status("current ordinary status");
	const text = stripAnsi(mode.chatContainer.render(120).join("\n"));
	expect(text).toContain("first diagnostic");
	expect(text).toContain("second diagnostic");
	expect(text).toContain("current ordinary status");
	expect(text).not.toContain("old ordinary status");
});

test("stderr delivery does not create engine callback activity", () => {
	const runtime = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
	const publish = vi.fn();
	Object.assign(runtime, { health: { publish }, engineCallbackActive: false });
	runtime.emitDiagnostic({
		activity: undefined,
		elapsedMs: 0,
		level: "blocking",
		source: "stderr",
		message: "diagnostic",
	});
	expect(Reflect.get(runtime, "engineCallbackActive")).toBe(false);
	expect(publish).toHaveBeenCalledOnce();
});

// Regression #2965: status components are ANSI-aware, not a terminal-control boundary.
test("renders child diagnostics as inert text without mutating the raw diagnostic", () => {
	initTheme("dark");
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, { chatContainer: new Container(), ui: { requestRender: vi.fn() } });
	mode.showStatus("transcript before diagnostic", true);
	const message =
		"  CONTROL_BEFORE\x1b[2J\x1b[1;1HCONTROL_AFTER\n\tduplicate\n\tduplicate\n" +
		"\x1b]52;c;Y2xpcGJvYXJk\x07\x1bPpayload\x1b\\\x9b2J\x9dtitle\x9c\r\b\x00\x7f\x1b";
	const diagnostic = {
		activity: undefined,
		elapsedMs: 0,
		level: "blocking" as const,
		source: "stderr" as const,
		message,
	};
	const showStatus = vi.fn(mode.showStatus.bind(mode));
	renderEngineDiagnostic(diagnostic, { showStatus, showError: vi.fn(), stopWorkingLoader: vi.fn() });
	expect(diagnostic.message).toBe(message);
	const displayed = showStatus.mock.calls[0]![0];
	expect(displayed).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	expect(displayed).toContain("  CONTROL_BEFORECONTROL_AFTER\n\tduplicate\n\tduplicate\n");
	const rendered = mode.chatContainer.render(120).join("\n");
	expect(rendered).not.toContain("\x1b[2J");
	expect(rendered).not.toContain("\x1b[1;1H");
	expect(stripAnsi(rendered)).toContain("transcript before diagnostic");
	expect(stripAnsi(rendered)).toContain("CONTROL_BEFORECONTROL_AFTER");
});

// Regression #2995: sustained stderr must not retain an unlimited transcript.
test("bounds diagnostic history while preserving ordinary chat, recent duplicates and order after clear", () => {
	initTheme("dark");
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, { chatContainer: new Container(), ui: { requestRender: vi.fn() } });
	const view = { showStatus: mode.showStatus.bind(mode), showError: vi.fn(), stopWorkingLoader: vi.fn() };
	const report = (message: string) =>
		renderEngineDiagnostic({ activity: undefined, elapsedMs: 0, level: "blocking", source: "stderr", message }, view);
	for (const large of [false, true]) {
		mode.chatContainer.clear();
		mode.showStatus("ordinary status retained");
		mode.chatContainer.addChild(new Text("user chat retained"));
		const ordinaryChildren = [...mode.chatContainer.children];
		for (let i = 0; i < 200; i++) report(`diagnostic-${i} ${large ? "😀".repeat(4096) : ""}`);
		report("recent duplicate");
		report("recent duplicate");
		report("latest diagnostic");
		mode.showStatus("old ordinary status");
		mode.showStatus("current ordinary status");
		const rendered = stripAnsi(mode.chatContainer.render(120).join("\n"));
		expect(mode.chatContainer.children.length).toBeLessThanOrEqual(ordinaryChildren.length + 64 * 2 + 2);
		expect(Buffer.byteLength(rendered)).toBeLessThan(280 * 1024);
		for (const child of ordinaryChildren) expect(mode.chatContainer.children).toContain(child);
		expect(rendered).not.toContain("diagnostic-0 ");
		expect(rendered).toContain("diagnostic-199 ");
		expect(rendered.match(/recent duplicate/g)).toHaveLength(2);
		expect(rendered.indexOf("diagnostic-199 ")).toBeLessThan(rendered.indexOf("recent duplicate"));
		expect(rendered.lastIndexOf("recent duplicate")).toBeLessThan(rendered.indexOf("latest diagnostic"));
		expect(rendered).toContain("current ordinary status");
		expect(rendered).not.toContain("old ordinary status");
	}
});

test("shows a deprecation warning the engine also prints on stderr once, through the host's warnings", async () => {
	const { clearDeprecationWarningsForTests, setDeprecationWarningSink, warnDeprecation } = await import(
		"../src/utils/deprecation.js"
	);
	clearDeprecationWarningsForTests();
	const warnings: string[] = [];
	const restore = setDeprecationWarningSink((message) => warnings.push(message));
	try {
		const statuses: string[] = [];
		const view = {
			showStatus: (message: string) => statuses.push(message),
			showError: vi.fn(),
			stopWorkingLoader: vi.fn(),
		};
		warnDeprecation('Ignored legacy "routerModel" because "decisionModel" is already set.');
		renderEngineDiagnostic(
			{
				activity: undefined,
				elapsedMs: 0,
				level: "blocking",
				source: "stderr",
				message:
					'\u001b[33mDeprecation warning: Ignored legacy "routerModel" because "decisionModel" is already set.\u001b[39m\nDeprecation warning: an engine-only notice\nengine diagnostic\n',
			},
			view,
		);
		expect(warnings).toEqual([
			'Ignored legacy "routerModel" because "decisionModel" is already set.',
			"an engine-only notice",
		]);
		expect(statuses).toEqual(["engine diagnostic\n"]);
	} finally {
		restore();
		clearDeprecationWarningsForTests();
	}
});
