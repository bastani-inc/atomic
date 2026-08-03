import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { openExternalEditorForText } from "../src/modes/interactive/chat-input-actions.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import {
	type ExternalEditorResult,
	editInExternalEditor,
	quoteWindowsShellArgument,
	resolveExternalEditorCommand,
} from "../src/modes/interactive/external-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-external-editor.mjs", import.meta.url));
const externalEditorSourcePath = fileURLToPath(new URL("../src/modes/interactive/external-editor.ts", import.meta.url));
const extensionDialogsSourcePath = fileURLToPath(
	new URL("../src/modes/interactive/interactive-extension-dialogs.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
	fileMode: number;
}

function quote(value: string): string {
	return JSON.stringify(value);
}

async function runEditor(
	flag?: "--fail" | "--empty",
	prefix = `${APP_NAME}-external-editor-test-`,
): Promise<{ result: ExternalEditorResult; capture: EditorCapture }> {
	const captureDirectory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(captureDirectory);
	const capturePath = join(captureDirectory, "capture output.json");
	const command = [quote(process.execPath), quote(fixturePath), quote(capturePath), ...(flag ? [flag] : [])].join(" ");
	const result = await editInExternalEditor({ command, content: "original" });
	const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
	return { result, capture };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("editInExternalEditor", () => {
	it("edits exact prompt.md inside a private Atomic temporary directory", async () => {
		const { result, capture } = await runEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(new RegExp(`^${APP_NAME}-editor-.+$`));
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.directoryMode & 0o077).toBe(0);
			expect(capture.fileMode & 0o077).toBe(0);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original when the editor fails and recursively cleans up", async () => {
		const { result, capture } = await runEditor("--fail");
		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});

	it("distinguishes a successful empty edit from failure", async () => {
		const { result, capture } = await runEditor("--empty");
		expect(result).toEqual({ status: "complete", content: "" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});

	it("parses quoted commands and arguments containing spaces", async () => {
		const { result } = await runEditor(undefined, `${APP_NAME} editor capture `);
		expect(result).toEqual({ status: "complete", content: "edited" });
	});

	it("uses async spawn and never scans the temporary directory", () => {
		const source = readFileSync(externalEditorSourcePath, "utf-8");
		expect(source).toContain("spawn(");
		expect(source).not.toMatch(/\bspawnSync\s*\(/);
		expect(source).not.toContain("readdir");
		expect(source).not.toContain("glob");
	});

	it("quotes every shell token so cmd.exe cannot split arguments on spaces", () => {
		const source = readFileSync(externalEditorSourcePath, "utf-8");
		// Node leaves the command line unquoted under `shell: true`, so the
		// spawn call itself must route both the editor and its arguments
		// through the quoter rather than passing raw values.
		expect(source).toContain("useShell ? quoteWindowsShellArgument(editor) : editor");
		expect(source).toContain("useShell ? spawnArgs.map(quoteWindowsShellArgument) : spawnArgs");
	});
});

/**
 * Reference implementation of the `CommandLineToArgvW` rules that Windows
 * programs use to split a command line back into arguments. Quoting is only
 * correct if a quoted line parses back to the exact arguments we started
 * with, so the round-trip below is the real assertion.
 */
function parseWindowsCommandLine(commandLine: string): string[] {
	const argv: string[] = [];
	let current = "";
	let inQuotes = false;
	let started = false;
	let index = 0;

	while (index < commandLine.length) {
		const character = commandLine[index];
		if (character === "\\") {
			let slashes = 0;
			while (commandLine[index] === "\\") {
				slashes += 1;
				index += 1;
			}
			if (commandLine[index] === '"') {
				current += "\\".repeat(Math.floor(slashes / 2));
				if (slashes % 2 === 1) current += '"';
				else inQuotes = !inQuotes;
				index += 1;
			} else {
				current += "\\".repeat(slashes);
			}
			started = true;
			continue;
		}
		index += 1;
		if (character === '"') {
			inQuotes = !inQuotes;
			started = true;
			continue;
		}
		if (!inQuotes && /\s/.test(character)) {
			if (started) {
				argv.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}

	if (started) argv.push(current);
	return argv;
}

describe("quoteWindowsShellArgument", () => {
	it("wraps plain values and values containing spaces", () => {
		expect(quoteWindowsShellArgument("notepad")).toBe('"notepad"');
		expect(quoteWindowsShellArgument(String.raw`C:\Temp\capture output.json`)).toBe(
			String.raw`"C:\Temp\capture output.json"`,
		);
		expect(quoteWindowsShellArgument("")).toBe('""');
	});

	it("doubles a trailing backslash run so it cannot escape the closing quote", () => {
		expect(quoteWindowsShellArgument("C:\\Program Files\\")).toBe('"C:\\Program Files\\\\"');
	});

	it("escapes embedded quotes and the backslashes preceding them", () => {
		expect(quoteWindowsShellArgument('a"b')).toBe('"a\\"b"');
		expect(quoteWindowsShellArgument('a\\"b')).toBe('"a\\\\\\"b"');
	});

	it("round-trips a full command line back to the exact original arguments", () => {
		const args = [
			String.raw`C:\Program Files\Microsoft VS Code\Code.exe`,
			"--wait",
			String.raw`C:\Temp\atomic-editor-x\capture output.json`,
			String.raw`C:\Temp\atomic editor capture y\prompt.md`,
			"C:\\trailing\\",
			'quote"inside',
			"",
		];

		const commandLine = args.map(quoteWindowsShellArgument).join(" ");
		expect(parseWindowsCommandLine(commandLine)).toEqual(args);
	});
});

describe("external editor selection and hosts", () => {
	it("prefers configured, VISUAL, EDITOR, then the platform fallback", () => {
		expect(
			resolveExternalEditorCommand("configured --wait", {
				VISUAL: "visual",
				EDITOR: "editor",
			}),
		).toBe("configured --wait");
		expect(resolveExternalEditorCommand(undefined, { VISUAL: "visual", EDITOR: "editor" })).toBe("visual");
		expect(resolveExternalEditorCommand(undefined, { EDITOR: "editor" })).toBe("editor");
		expect(resolveExternalEditorCommand(undefined, {}, "linux")).toBe("nano");
		expect(resolveExternalEditorCommand(undefined, {}, "win32")).toBe("notepad");
	});

	it("restarts and renders the main host in finally after a failed edit", async () => {
		const captureDirectory = mkdtempSync(join(tmpdir(), `${APP_NAME}-host-editor-test-`));
		temporaryDirectories.push(captureDirectory);
		const capturePath = join(captureDirectory, "capture.json");
		const command = `${quote(process.execPath)} ${quote(fixturePath)} ${quote(capturePath)} --fail`;
		const lifecycle: string[] = [];
		const updated = await openExternalEditorForText(
			"original",
			{
				stop: () => lifecycle.push("stop"),
				start: () => lifecycle.push("start"),
				requestRender: (force) => lifecycle.push(`render:${String(force)}`),
			},
			{ editorCommand: command },
		);

		expect(updated).toBeUndefined();
		expect(lifecycle).toEqual(["stop", "start", "render:true"]);
	});

	it("returns a successful empty edit while still restoring the main host", async () => {
		const captureDirectory = mkdtempSync(join(tmpdir(), `${APP_NAME}-empty-editor-test-`));
		temporaryDirectories.push(captureDirectory);
		const capturePath = join(captureDirectory, "capture.json");
		const command = `${quote(process.execPath)} ${quote(fixturePath)} ${quote(capturePath)} --empty`;
		const lifecycle: string[] = [];
		const updated = await openExternalEditorForText(
			"original",
			{
				stop: () => lifecycle.push("stop"),
				start: () => lifecycle.push("start"),
				requestRender: (force) => lifecycle.push(`render:${String(force)}`),
			},
			{ editorCommand: command },
		);

		expect(updated).toBe("");
		expect(lifecycle).toEqual(["stop", "start", "render:true"]);
	});

	it("shows the external-editor hint and applies configured command in extension UI", async () => {
		const captureDirectory = mkdtempSync(join(tmpdir(), `${APP_NAME}-component-editor-test-`));
		temporaryDirectories.push(captureDirectory);
		expect(readFileSync(extensionDialogsSourcePath, "utf-8")).toContain(
			"this.settingsManager.getExternalEditorCommand()",
		);
		const capturePath = join(captureDirectory, "capture.json");
		const command = `${quote(process.execPath)} ${quote(fixturePath)} ${quote(capturePath)}`;
		const lifecycle: string[] = [];
		const tui = {
			stop: () => lifecycle.push("stop"),
			start: () => lifecycle.push("start"),
			requestRender: (force?: boolean) => lifecycle.push(`render:${String(force)}`),
		} as unknown as TUI;
		initTheme("dark", false);
		const component = new ExtensionEditorComponent(
			tui,
			new KeybindingsManager(),
			"Extension prompt",
			"original",
			() => {},
			() => {},
			undefined,
			command,
		);
		const textChildren = (component as unknown as { children: object[] }).children.filter(
			(child): child is Text => child instanceof Text,
		);
		const rendered = textChildren.flatMap((child) => child.render(100)).join("\n");
		expect(rendered).toContain("external editor");

		const testable = component as unknown as {
			handleOpenExternalEditor(): Promise<void>;
			editor: { getText(): string };
		};
		await testable.handleOpenExternalEditor();
		expect(testable.editor.getText()).toBe("edited");
		expect(lifecycle).toEqual(["stop", "start", "render:true"]);
	});
});
