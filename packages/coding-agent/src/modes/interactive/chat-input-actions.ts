import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../config.ts";
import { readClipboardText } from "../../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts";
import { editInExternalEditor, resolveExternalEditorCommand } from "./external-editor.ts";

export interface ExternalEditorHost {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

export interface ExternalEditorOptions {
	editorCommand?: string;
	showWarning?: (message: string) => void;
}

export interface ClipboardImageEditorOptions {
	showWarning?: (message: string) => void;
	cleanupDelayMs?: number;
}

const CLIPBOARD_CLEANUP_DELAY_MS = 60 * 60 * 1000;
const CLIPBOARD_STALE_AGE_MS = 24 * 60 * 60 * 1000;

function appTempPrefix(kind: string): string {
	return `${APP_NAME}-${kind}-`;
}

function scheduleTempFileCleanup(filePath: string, delayMs: number): void {
	const timer = setTimeout(() => {
		try {
			fs.unlinkSync(filePath);
		} catch {
			// Ignore best-effort cleanup failures.
		}
	}, delayMs);
	timer.unref?.();
}

export function cleanupStaleClipboardFiles(now = Date.now()): void {
	const prefix = appTempPrefix("clipboard");
	let entries: string[];
	try {
		entries = fs.readdirSync(os.tmpdir());
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const filePath = path.join(os.tmpdir(), entry);
		try {
			const stat = fs.statSync(filePath);
			if (stat.isFile() && now - stat.mtimeMs >= CLIPBOARD_STALE_AGE_MS) fs.unlinkSync(filePath);
		} catch {
			// Ignore best-effort cleanup failures.
		}
	}
}

export function combineQueuedMessagesForEditor(queuedMessages: readonly string[], currentText: string): string {
	return [...queuedMessages, ...(currentText.trim() ? [currentText] : [])].join("\n\n");
}

export interface ClipboardImageEditorTarget {
	insertTextAtCursor?: (text: string) => void;
	getText?: () => string;
	setText?: (text: string) => void;
}

export async function pasteClipboardImageToEditor(
	editor: ClipboardImageEditorTarget,
	requestRender?: () => void,
	options: ClipboardImageEditorOptions = {},
): Promise<boolean> {
	try {
		cleanupStaleClipboardFiles();
		const image = await readClipboardImage();
		if (!image) {
			const text = await readClipboardText();
			if (!text) return false;
			if (editor.insertTextAtCursor) editor.insertTextAtCursor(text);
			else if (editor.getText && editor.setText) editor.setText(`${editor.getText()}${text}`);
			else return false;
			requestRender?.();
			return true;
		}

		const ext = extensionForImageMimeType(image.mimeType) ?? "png";
		const fileName = `${appTempPrefix("clipboard")}${crypto.randomUUID()}.${ext}`;
		const filePath = path.join(os.tmpdir(), fileName);
		fs.writeFileSync(filePath, Buffer.from(image.bytes), { flag: "wx", mode: 0o600 });
		scheduleTempFileCleanup(filePath, options.cleanupDelayMs ?? CLIPBOARD_CLEANUP_DELAY_MS);

		if (editor.insertTextAtCursor) editor.insertTextAtCursor(filePath);
		else if (editor.getText && editor.setText) editor.setText(`${editor.getText()}${filePath}`);
		else return false;
		requestRender?.();
		return true;
	} catch (error) {
		options.showWarning?.(
			`Failed to paste clipboard image: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

export async function openExternalEditorForText(
	text: string,
	host: Pick<TUI, "stop" | "start" | "requestRender"> | ExternalEditorHost,
	options: ExternalEditorOptions = {},
): Promise<string | undefined> {
	const editorCommand = resolveExternalEditorCommand(options.editorCommand);
	host.stop();
	try {
		const result = await editInExternalEditor({
			command: editorCommand,
			content: text,
		});
		return result.status === "complete" ? result.content : undefined;
	} catch (error) {
		options.showWarning?.(`Failed to open editor: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	} finally {
		host.start();
		host.requestRender(true);
	}
}
