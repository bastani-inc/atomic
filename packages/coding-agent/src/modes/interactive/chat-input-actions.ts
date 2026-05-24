import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { EditorComponent, TUI } from "@earendil-works/pi-tui";
import {
  extensionForImageMimeType,
  readClipboardImage,
} from "../../utils/clipboard-image.ts";
import { APP_NAME } from "../../config.ts";

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

function parseEditorCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (escaped) current += "\\";
  if (started) args.push(current);
  return args;
}

export function combineQueuedMessagesForEditor(
  queuedMessages: readonly string[],
  currentText: string,
): string {
  return [
    ...queuedMessages,
    ...(currentText.trim() ? [currentText] : []),
  ].join("\n\n");
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
    if (!image) return false;

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

export function openExternalEditorForText(
  text: string,
  host: Pick<TUI, "stop" | "start" | "requestRender"> | ExternalEditorHost,
  options: ExternalEditorOptions = {},
): string | undefined {
  const editorCommand = options.editorCommand ?? process.env.VISUAL ?? process.env.EDITOR;
  if (!editorCommand) {
    options.showWarning?.("No editor configured. Set $VISUAL or $EDITOR environment variable.");
    return undefined;
  }

  const tmpFile = path.join(
    os.tmpdir(),
    // Keep the app name in both the prefix and extension so editor tabs and
    // file-type hints stay branded while preserving the legacy .<app>.md shape.
    `${APP_NAME}-editor-${crypto.randomUUID()}.${APP_NAME}.md`,
  );
  let tmpFileCreated = false;
  let hostStopped = false;
  try {
    fs.writeFileSync(tmpFile, text, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    tmpFileCreated = true;
    host.stop();
    hostStopped = true;

    const [editor, ...editorArgs] = parseEditorCommand(editorCommand);
    if (!editor) return undefined;
    const result = spawnSync(editor, [...editorArgs, tmpFile], {
      stdio: "inherit",
      // Windows editor commands often rely on shell resolution for .cmd/.bat
      // launchers; keep this limited to trusted $VISUAL/$EDITOR input.
      shell: process.platform === "win32",
    });

    if (result.error) {
      options.showWarning?.(`Failed to open editor: ${result.error.message}`);
      return undefined;
    }
    if (result.status !== 0) return undefined;
    return fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
  } finally {
    if (tmpFileCreated) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors.
      }
    }
    if (hostStopped) {
      host.start();
      host.requestRender(true);
    }
  }
}
