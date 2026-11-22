/**
 * Log messages MCP servers send with `notifications/message`, appended to `mcp.log` in the agent
 * directory. Several pi processes may write to the same file, so every message is one append; a
 * process appends its messages one at a time, in the order they arrived. The file is rotated to
 * `mcp.log.1` once it grows past `MAX_LOG_BYTES`.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { redactOAuthErrorText } from "./client/oauth/redact.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatData(data: unknown): string {
	if (typeof data === "string") return data;
	try {
		return JSON.stringify(data) ?? String(data);
	} catch {
		return String(data);
	}
}

/** Format one `notifications/message` from `server` as a log line; continuation lines are indented. */
export function formatMcpLogMessage(
	server: string,
	params: unknown,
	now: Date = new Date(),
	secrets: Iterable<string | undefined> = [],
	preRedacted = false,
): string {
	const message = isRecord(params) ? params : { data: params };
	const level = typeof message.level === "string" ? message.level : "info";
	const rawLogger = typeof message.logger === "string" && message.logger ? message.logger : "";
	const logger = rawLogger ? ` ${preRedacted ? rawLogger : redactOAuthErrorText(rawLogger, secrets)}:` : "";
	const rawText = formatData(message.data);
	const text = (preRedacted ? rawText : redactOAuthErrorText(rawText, secrets)).replace(/\r?\n/g, "\n    ");
	return `${now.toISOString()} [${server}] ${level}${logger} ${text}\n`;
}

/** Appends server log messages to one file. Write errors are ignored: logging must not break tools. */
export class McpServerLog {
	readonly path: string;
	private size: number | undefined;
	private appending: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	write(server: string, params: unknown, secrets?: Iterable<string | undefined>): void {
		const line = formatMcpLogMessage(server, params, new Date(), secrets);
		this.appending = this.appending.then(() => this.append(line));
	}

	/** Append a message whose untrusted parts have already been redacted by the caller. */
	writeRedacted(server: string, params: unknown): void {
		const line = formatMcpLogMessage(server, params, new Date(), [], true);
		this.appending = this.appending.then(() => this.append(line));
	}

	flush(): Promise<void> {
		return this.appending;
	}

	private async append(line: string): Promise<void> {
		try {
			if (this.size === undefined) {
				await mkdir(dirname(this.path), { recursive: true });
				this.size = await this.currentSize();
			}
			if (this.size > MAX_LOG_BYTES) {
				// Another process may have rotated it already; check before renaming.
				if ((await this.currentSize()) > MAX_LOG_BYTES) await rename(this.path, `${this.path}.1`);
				this.size = await this.currentSize();
			}
			await appendFile(this.path, line);
			this.size += Buffer.byteLength(line);
		} catch {
			// Ignore: the log is best effort.
		}
	}

	private async currentSize(): Promise<number> {
		try {
			return (await stat(this.path)).size;
		} catch {
			return 0;
		}
	}
}
