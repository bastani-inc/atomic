/**
 * Every list a user picks from runs its rows on one click. A view that handles the keys that choose a row (Enter, the
 * list's confirm or open key) has to say here how a click reaches those rows, so a new list cannot ship keyboard-only.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { repositoryRoot } from "../../vitest.base.js";

/** The keys that choose or open the selected row of a list. */
const CHOOSE_KEYS =
	/"tui\.select\.confirm"|"app\.list\.open"|TUI_ACTION\.selectConfirm|KEYBIND_CONFIRM|matchesKey\(data, "enter"\)|matchesKey\(data, Key\.enter\)/;

/** Rows drawn here run through the shared clickable-row path. */
const ROWS = /\bClickableRows?\b/;

type Route =
	/** The file draws its rows through `ClickableRows` or `ClickableRow`. */
	| { readonly route: "rows" }
	/** The file hosts a list and forwards each mouse event to it. */
	| { readonly route: "forwards"; readonly to: string }
	/** Another file draws the rows these keys move through, on the clickable-row path. */
	| { readonly route: "drawn-by"; readonly file: string }
	/** Nothing here is a row a user picks. */
	| { readonly route: "no-rows"; readonly reason: string };

const rows: Route = { route: "rows" };
const TEXT_FIELD = "a text field: Enter submits what was typed, and there is no row to pick";
const KEY_DEFINITIONS = "key definitions, not a view";

const ROUTES: Record<string, Route> = {
	"packages/coding-agent/src/cli/startup-ui.ts": {
		route: "no-rows",
		reason:
			"startup prompts run on the main-screen renderer before the full-screen view starts, with no mouse reporting",
	},
	"packages/coding-agent/src/core/extensions/runner-shortcuts.ts": { route: "no-rows", reason: KEY_DEFINITIONS },
	"packages/coding-agent/src/core/keybindings.ts": { route: "no-rows", reason: KEY_DEFINITIONS },
	"packages/coding-agent/src/core/tools/ask-user-question/state/key-router.ts": {
		route: "drawn-by",
		file: "packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts",
	},
	"packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts": rows,
	"packages/coding-agent/src/extensions/llama/huggingface-ui.ts": rows,
	"packages/coding-agent/src/extensions/mcp/ui.ts": { route: "forwards", to: "its FramedSelector menu" },
	"packages/coding-agent/src/modes/interactive/components/agent-panel.ts": {
		route: "drawn-by",
		file: "packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts",
	},
	"packages/coding-agent/src/modes/interactive/components/chat-session-host-editor.ts": {
		route: "no-rows",
		reason: TEXT_FIELD,
	},
	"packages/coding-agent/src/modes/interactive/components/config-selector-list.ts": rows,
	"packages/coding-agent/src/modes/interactive/components/custom-editor.ts": {
		route: "drawn-by",
		file: "packages/tui/src/components/editor.ts",
	},
	"packages/coding-agent/src/modes/interactive/components/extension-editor.ts": {
		route: "no-rows",
		reason: TEXT_FIELD,
	},
	"packages/coding-agent/src/modes/interactive/components/extension-input.ts": {
		route: "no-rows",
		reason: TEXT_FIELD,
	},
	"packages/coding-agent/src/modes/interactive/components/first-time-setup.ts": rows,
	"packages/coding-agent/src/modes/interactive/components/host-input-form.ts": rows,
	"packages/coding-agent/src/modes/interactive/components/login-dialog.ts": { route: "no-rows", reason: TEXT_FIELD },
	"packages/coding-agent/src/modes/interactive/components/selector.ts": rows,
	"packages/coding-agent/src/modes/interactive/components/session-selector-list.ts": rows,
	"packages/coding-agent/src/modes/interactive/components/session-selector.ts": {
		route: "drawn-by",
		file: "packages/coding-agent/src/modes/interactive/components/session-selector-list.ts",
	},
	"packages/coding-agent/src/modes/interactive/components/task-inspector.ts": rows,
	"packages/coding-agent/src/modes/interactive/components/task-navigation.ts": {
		route: "drawn-by",
		file: "packages/coding-agent/src/modes/interactive/components/task-inspector.ts",
	},
	"packages/coding-agent/src/modes/interactive/components/task-transcript-page.ts": {
		route: "forwards",
		to: "the task's held question form",
	},
	"packages/coding-agent/src/modes/interactive/components/tree-selector-help.ts": {
		route: "no-rows",
		reason: "the key list of /tree, with no row to pick",
	},
	"packages/coding-agent/src/modes/interactive/components/tree-selector-label-input.ts": {
		route: "no-rows",
		reason: TEXT_FIELD,
	},
	"packages/coding-agent/src/modes/interactive/components/tree-selector-list.ts": rows,
	"packages/coding-agent/src/modes/interactive/components/trust-decision-selector.ts": {
		route: "drawn-by",
		file: "packages/coding-agent/src/modes/interactive/components/selector.ts",
	},
	"packages/intercom/ui/compose.ts": { route: "no-rows", reason: TEXT_FIELD },
	"packages/intercom/ui/session-list.ts": rows,
	"packages/subagents/src/tui/agent-browser.ts": rows,
	"packages/tui/src/components/editor.ts": { route: "forwards", to: "its autocomplete SelectList" },
	"packages/tui/src/components/select-list.ts": rows,
	"packages/tui/src/components/settings-list.ts": rows,
	"packages/tui/src/keybindings.ts": { route: "no-rows", reason: KEY_DEFINITIONS },
	"packages/workflows/src/extension/workflow-durable-resume-command.ts": {
		route: "no-rows",
		reason: "a confirmation whose only actions are its key hints, which the key-hint path runs on a click",
	},
	"packages/workflows/src/tui/graph-view-input.ts": {
		route: "no-rows",
		reason: "graph nodes and the stage switcher open on a press through the graph's own hit test",
	},
	"packages/workflows/src/tui/keybindings-adapter.ts": { route: "no-rows", reason: KEY_DEFINITIONS },
	"packages/workflows/src/tui/prompt-card-input.ts": {
		route: "drawn-by",
		file: "packages/workflows/src/tui/stage-chat-view.ts",
	},
	"packages/workflows/src/tui/prompt-card-render.ts": rows,
	"packages/workflows/src/tui/prompt-card-select.ts": {
		route: "drawn-by",
		file: "packages/workflows/src/tui/prompt-card-render.ts",
	},
	"packages/workflows/src/tui/stage-chat-view-input.ts": {
		route: "drawn-by",
		file: "packages/workflows/src/tui/stage-chat-view.ts",
	},
	"packages/workflows/src/tui/workflow-attach-pane.ts": { route: "forwards", to: "the attached stage chat" },
	"packages/workflows/src/tui/workflows-listing.ts": rows,
};

/** Source directories of the packages that draw views. */
const SOURCE_ROOTS = [
	"packages/coding-agent/src",
	"packages/tui/src",
	"packages/workflows/src",
	"packages/subagents/src",
	"packages/intercom",
	"packages/mcp",
	"packages/web-access",
];

function sourceFiles(directory: string): string[] {
	const absolute = join(repositoryRoot, directory);
	let entries: string[];
	try {
		entries = readdirSync(absolute);
	} catch {
		return [];
	}
	return entries.flatMap((entry) => {
		if (entry === "node_modules" || entry === "test" || entry === "tests" || entry === "dist") return [];
		const path = join(absolute, entry);
		if (statSync(path).isDirectory()) return sourceFiles(relative(repositoryRoot, path));
		return entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")
			? [relative(repositoryRoot, path).split("\\").join("/")]
			: [];
	});
}

const read = (path: string): string => readFileSync(join(repositoryRoot, path), "utf8");

test("every view that chooses a row with a key says how a click reaches that row", () => {
	const lists = [...new Set(SOURCE_ROOTS.flatMap(sourceFiles))].filter((path) => CHOOSE_KEYS.test(read(path))).sort();
	const unclassified = lists.filter((path) => ROUTES[path] === undefined);
	assert.deepEqual(
		unclassified,
		[],
		"These files handle a key that chooses a list row. Draw the rows through ClickableRows or ClickableRow, " +
			"or add the file to ROUTES with how a click reaches its rows.",
	);
	const stale = Object.keys(ROUTES).filter((path) => !lists.includes(path));
	assert.deepEqual(stale, [], "These ROUTES entries no longer handle a choosing key; remove them.");
});

test("the files said to draw clickable rows use the clickable-row path, and the forwarding ones forward clicks", () => {
	for (const [path, route] of Object.entries(ROUTES)) {
		const source = read(path);
		if (route.route === "rows") assert.match(source, ROWS, `${path} draws rows without ClickableRows`);
		if (route.route === "forwards") assert.match(source, /handleMouse/, `${path} forwards no click to ${route.to}`);
		if (route.route === "drawn-by") {
			const drawing = read(route.file);
			assert.ok(
				ROWS.test(drawing) || /handleMouse/.test(drawing),
				`${route.file}, which draws the rows of ${path}, takes no click`,
			);
		}
	}
});
