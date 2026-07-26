import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "../../config.ts";

export interface ExternalEditorRequest {
	command: string;
	content: string;
}

export type ExternalEditorResult =
	| { status: "complete"; content: string }
	| { status: "failed" };

function parseEditorCommand(command: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	let started = false;

	for (const character of command) {
		if (escaped) {
			current += character;
			escaped = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			else current += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) {
				args.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}

	if (escaped) current += "\\";
	if (started) args.push(current);
	return args;
}

export function resolveExternalEditorCommand(
	configuredCommand?: string,
	environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (configuredCommand?.trim()) return configuredCommand;
	if (environment.VISUAL) return environment.VISUAL;
	if (environment.EDITOR) return environment.EDITOR;
	return platform === "win32" ? "notepad" : "nano";
}

export async function editInExternalEditor(
	request: ExternalEditorRequest,
): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), `${APP_NAME}-editor-`));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, request.content, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		const [editor, ...editorArgs] = parseEditorCommand(request.command);
		if (!editor) return { status: "failed" };

		process.stdout.write(
			`Launching external editor: ${request.command}\n${APP_NAME} will resume when the editor exits.\n`,
		);

		// Do not use spawnSync. On Windows, synchronous child_process calls can
		// leave a console read active and race the editor for keyboard input.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.once("error", () => resolve(null));
			child.once("close", (code) => resolve(code));
		});

		if (exitCode !== 0) return { status: "failed" };
		return {
			status: "complete",
			content: readFileSync(filePath, "utf-8").replace(/\n$/, ""),
		};
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
