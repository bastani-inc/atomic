import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { CustomEditor, parseSkillBlock } from "@bastani/atomic";
import { fauxAssistantMessage, type FauxResponseFactory } from "@bastani/pi-ai/compat";
import { ProcessTerminal, setKeybindings, TuiAltScreen } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import { createStageSkillFixture } from "./stage-chat-skill-session.js";

const { values } = parseArgs({
	options: { "evidence-dir": { type: "string" }, "run-id": { type: "string" } },
	strict: true,
});
const evidenceDirectory = values["evidence-dir"];
const runId = values["run-id"];
if (!evidenceDirectory || !runId) throw new Error("Provide --evidence-dir <fresh-directory> --run-id <nonce>");
mkdirSync(dirname(evidenceDirectory), { recursive: true });
mkdirSync(evidenceDirectory); // Existing evidence must never be overwritten or mistaken for this run.
const barriers = join(evidenceDirectory, "barriers.jsonl");
const events = join(evidenceDirectory, "events.jsonl");
const fixture = await createStageSkillFixture();
let stopping = false;
let mounted = false;
let firstRender = true;
let revision = 0;
let editor: CustomEditor | undefined;
let renderedLines: string[] = [];
const keybindings = new KeybindingsManager({});
setKeybindings(keybindings);

function appendBarrier(barrier: string, evidence: object): void {
	appendFileSync(barriers, `${JSON.stringify({ runId, barrier, revision: String(revision), evidence })}\n`);
}

class EvidenceTui extends TuiAltScreen {
	protected override doRender(): void {
		super.doRender();
		if (!mounted || stopping) return;
		revision++;
		const currentRevision = revision;
		const evidence = {
			host: "workflow",
			runId: fixture.runId,
			stageId: fixture.stageId,
			sessionId: fixture.handle.sessionId,
			stageStatus: fixture.handle.status,
			columns: this.terminal.columns,
			rows: this.terminal.rows,
			editorText: editor?.getText() ?? "",
			renderedLines: [...renderedLines],
			userMessages: fixture.userTexts(),
			steering: [...fixture.stage.session.getSteeringMessages()],
			followUp: [...fixture.stage.session.getFollowUpMessages()],
		};
		const barrier = firstRender ? "ready" : "rendered";
		firstRender = false;
		process.stdout.write("", () => {
			appendFileSync(barriers, `${JSON.stringify({ runId, barrier, revision: String(currentRevision), evidence })}\n`);
		});
	}
}

const tui = new EvidenceTui(new ProcessTerminal());
const view = fixture.mount({
	piTui: tui,
	piKeybindings: keybindings,
	piEditorFactory: (host, theme, bindings) => {
		editor = new CustomEditor(host, theme, bindings as KeybindingsManager);
		return editor;
	},
	requestRender: () => tui.requestRender(),
	onClose: () => { void stop(); },
});
const respond: FauxResponseFactory = (context) => {
	const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
	const text = getMessageText(message);
	const skill = parseSkillBlock(text);
	const response = skill
		? `Observed ${skill.name} from ${basename(dirname(dirname(skill.location)))}; args: ${skill.userMessage ?? ""}`
		: `Observed literal input: ${text}`;
	return fauxAssistantMessage(response);
};
fixture.stage.appendResponses(Array.from({ length: 32 }, () => respond));
const unsubscribe = fixture.stage.session.subscribe((event) => {
	appendFileSync(events, `${JSON.stringify({ runId, sessionId: fixture.handle.sessionId, event })}\n`);
});
const component = {
	focused: true,
	render(width: number) {
		renderedLines = view.render(width);
		return renderedLines;
	},
	handleInput(data: string) {
		if (data === "\x03") { void stop(); return true; }
		const handled = view.handleInput(data);
		tui.requestRender();
		return handled;
	},
	invalidate() { view.invalidate(); },
};
tui.addChild(component);
tui.setFocus(component);
mounted = true;
tui.start();

async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	unsubscribe();
	tui.stop();
	await fixture.cleanup();
	appendBarrier("stopped", { sessionId: fixture.handle.sessionId, stageId: fixture.stageId, disposed: true });
	process.exitCode = 0;
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
