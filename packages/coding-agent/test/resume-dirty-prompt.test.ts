import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { promptForDirtyCheckout, promptForMissingSessionCwd } from "../src/main-session.ts";

useTemporaryAgentDir();

const selector = vi.hoisted(() => ({
	pick: (_options: readonly string[]): string | undefined => undefined,
	shown: [] as { title: string; options: readonly string[] }[],
	stopped: 0,
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-tui")>()),
	ProcessTerminal: class {},
	TuiMainScreen: class {
		setClearOnShrink() {}
		addChild() {}
		setFocus() {}
		start() {}
		stop() {
			selector.stopped++;
		}
	},
	setCapabilityOverrides: () => {},
	setKeybindings: () => {},
}));

vi.mock("../src/modes/interactive/components/extension-selector.ts", () => ({
	ExtensionSelectorComponent: class {
		constructor(title: string, options: string[], onSelect: (option: string) => void, onCancel: () => void) {
			selector.shown.push({ title, options });
			const choice = selector.pick(options);
			queueMicrotask(() => {
				if (choice === undefined) onCancel();
				else onSelect(choice);
				if (choice !== undefined) onCancel();
			});
		}
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive/theme/theme.js")>()),
	initTheme: () => {},
}));

const settings = SettingsManager.inMemory();
const prompt = { checkout: "/home/b/repo", recordedRoot: "/home/a/repo", snapshotId: "0123456789abcdef0123" };

beforeEach(() => {
	selector.shown = [];
	selector.stopped = 0;
});

test("the dirty-checkout prompt offers restore first and maps each answer (#4329)", async () => {
	const answers: string[] = [];
	for (const index of [0, 1, 2]) {
		selector.pick = (options) => options[index];
		answers.push(await promptForDirtyCheckout(prompt, settings));
	}
	assert.deepEqual(answers, ["restore", "use", "cancel"]);
	assert.deepEqual(selector.shown[0]?.options, [
		"Restore the snapshot into a fresh worktree",
		"Continue in this checkout as it is",
		"Cancel",
	]);
	assert.equal(
		selector.shown[0]?.title,
		"This checkout differs from the session's snapshot 0123456789ab\n/home/b/repo\n\nrecorded in\n/home/a/repo",
	);
	assert.equal(selector.stopped, 3);
});

test("dismissing the dirty-checkout prompt cancels (#4329)", async () => {
	selector.pick = () => undefined;
	assert.equal(await promptForDirtyCheckout(prompt, settings), "cancel");
	assert.equal(selector.stopped, 1);
});

test("the missing-cwd prompt continues in the current directory or cancels", async () => {
	const issue = { sessionCwd: "/gone", fallbackCwd: "/here" };
	selector.pick = (options) => options[0];
	assert.equal(await promptForMissingSessionCwd(issue, settings), "/here");
	assert.deepEqual(selector.shown[0]?.options, ["Continue", "Cancel"]);
	selector.pick = (options) => options[1];
	assert.equal(await promptForMissingSessionCwd(issue, settings), undefined);
	selector.pick = () => undefined;
	assert.equal(await promptForMissingSessionCwd(issue, settings), undefined);
});
