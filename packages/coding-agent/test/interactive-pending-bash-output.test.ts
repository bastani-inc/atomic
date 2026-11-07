import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { renderAll } from "./interactive-mode-status-helpers.ts";

useTemporaryAgentDir();

type PendingBashComponent = { render: () => string[]; invalidate: () => void; setExpanded: ReturnType<typeof vi.fn> };

function createPendingBashComponent(): PendingBashComponent {
	return { render: () => [], invalidate: () => {}, setExpanded: vi.fn() };
}

const boundMethods = [
	"setToolsExpanded",
	"updatePendingMessagesDisplay",
	"getAllQueuedMessages",
	"flushPendingBashComponents",
	"handleEvent",
	"handleBashCommand",
	"renderCurrentSessionState",
] as const;

function createContext(pendingBashComponents: PendingBashComponent[], options: { streaming?: boolean } = {}) {
	const pendingMessagesContainer = new Container();
	for (const component of pendingBashComponents) pendingMessagesContainer.addChild(component);
	const fakeThis: any = {
		isInitialized: true,
		toolOutputExpanded: false,
		chatContainer: new Container(),
		pendingMessagesContainer,
		pendingBashComponents,
		compactionQueuedMessages: [],
		pendingTools: new Map(),
		session: {
			isStreaming: options.streaming ?? true,
			getSteeringMessages: () => ["steer"],
			getFollowUpMessages: () => [],
			extensionRunner: { emitUserBash: vi.fn(async () => undefined) },
			executeBash: vi.fn(async () => ({ exitCode: 0, cancelled: false, truncated: false, output: "" })),
			recordBashResult: vi.fn(async () => {}),
		},
		sessionManager: { getCwd: () => process.cwd() },
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		renderInitialMessages: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		getAppKeyDisplay: () => "alt+up",
	};
	for (const name of boundMethods) {
		fakeThis[name] = (InteractiveMode as any).prototype[name].bind(fakeThis);
	}
	return fakeThis;
}

describe("InteractiveMode pending user bash output (pi #11875)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("ctrl+o expands user bash output in the pending area", () => {
		const component = createPendingBashComponent();
		const fakeThis = createContext([component]);

		fakeThis.setToolsExpanded(true);

		expect(component.setExpanded).toHaveBeenCalledWith(true);
	});

	test("queued message updates keep user bash output in the pending area, ahead of the queue", () => {
		const component = createPendingBashComponent();
		const fakeThis = createContext([component]);

		fakeThis.updatePendingMessagesDisplay();
		fakeThis.setToolsExpanded(true);

		expect(fakeThis.pendingMessagesContainer.children[0]).toBe(component);
		expect(renderAll(fakeThis.pendingMessagesContainer)).toContain("Steering: steer");
		expect(component.setExpanded).toHaveBeenCalledWith(true);
	});

	test("settling the agent run moves user bash output to the chat", async () => {
		const component = createPendingBashComponent();
		const fakeThis = createContext([component]);

		await fakeThis.handleEvent({ type: "agent_settled", aborted: false });

		expect(fakeThis.pendingMessagesContainer.children).not.toContain(component);
		expect(fakeThis.chatContainer.children).toEqual([component]);
		expect(fakeThis.pendingBashComponents).toEqual([]);
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
		expect(fakeThis.checkShutdownRequested).toHaveBeenCalledTimes(1);
	});

	test("rendering another session's state drops pending user bash output", () => {
		const component = createPendingBashComponent();
		const fakeThis = createContext([component]);

		fakeThis.renderCurrentSessionState();
		expect(fakeThis.pendingBashComponents).toEqual([]);
		fakeThis.flushPendingBashComponents();

		expect(fakeThis.pendingBashComponents).toEqual([]);
		expect(fakeThis.chatContainer.children).toEqual([]);
		expect(fakeThis.renderInitialMessages).toHaveBeenCalledTimes(1);
	});

	for (const extensionResult of [false, true]) {
		for (const expanded of [false, true]) {
			test(`new user bash output starts ${expanded ? "expanded" : "collapsed"} while tool output is ${expanded ? "expanded" : "collapsed"} (extension result: ${extensionResult})`, async () => {
				const setExpanded = vi.spyOn(BashExecutionComponent.prototype, "setExpanded");
				const fakeThis = createContext([]);
				fakeThis.toolOutputExpanded = expanded;
				if (extensionResult) {
					fakeThis.session.extensionRunner.emitUserBash = vi.fn(async () => ({
						result: { output: "done\n", exitCode: 0, cancelled: false, truncated: false },
					}));
				}

				await fakeThis.handleBashCommand("echo done");

				expect(setExpanded).toHaveBeenCalledWith(expanded);
				expect(fakeThis.pendingBashComponents).toHaveLength(1);
				expect(fakeThis.pendingBashComponents[0]).toBeInstanceOf(BashExecutionComponent);
				expect(setExpanded.mock.contexts[0]).toBe(fakeThis.pendingBashComponents[0]);
			});
		}
	}
});
