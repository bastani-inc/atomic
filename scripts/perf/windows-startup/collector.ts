import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";

export const REQUIRED_BENCHMARK_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"workflow",
	"subagent",
	"mcp",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
	"intercom",
] as const;

type RequiredToolSchemaContract = {
	readonly properties: readonly string[];
	readonly required: readonly string[];
};

export const REQUIRED_BENCHMARK_TOOL_SCHEMAS: Readonly<
	Record<(typeof REQUIRED_BENCHMARK_TOOLS)[number], RequiredToolSchemaContract>
> = {
	read: { properties: ["path"], required: ["path"] },
	bash: { properties: ["command", "env", "timeout", "cwd", "pty"], required: ["command"] },
	edit: { properties: ["input"], required: ["input"] },
	write: { properties: ["path", "content"], required: ["path", "content"] },
	workflow: {
		properties: [
			"workflow",
			"inputs",
			"budget",
			"action",
			"runId",
			"all",
			"stageId",
			"message",
			"statusFilter",
			"format",
			"limit",
			"tail",
			"includeToolOutput",
			"text",
			"response",
			"promptId",
			"reason",
		],
		required: [],
	},
	subagent: {
		properties: [
			"agent",
			"task",
			"action",
			"id",
			"runId",
			"config",
			"tasks",
			"concurrency",
			"group",
			"worktree",
			"context",
			"agentScope",
			"cwd",
			"maxOutput",
			"artifacts",
			"includeProgress",
			"share",
			"sessionDir",
			"control",
			"output",
			"outputMode",
			"reads",
			"progress",
			"skill",
			"model",
		],
		required: [],
	},
	mcp: {
		properties: ["tool", "args", "connect", "describe", "search", "regex", "includeSchemas", "server", "action"],
		required: [],
	},
	web_search: {
		properties: ["query", "queries", "numResults", "includeContent", "recencyFilter", "domainFilter", "provider"],
		required: [],
	},
	code_search: { properties: ["query", "maxTokens"], required: ["query"] },
	fetch_content: {
		properties: ["url", "urls", "forceClone", "prompt", "timestamp", "frames", "model"],
		required: [],
	},
	get_search_content: {
		properties: ["responseId", "query", "queryIndex", "url", "urlIndex"],
		required: ["responseId"],
	},
	intercom: {
		properties: ["action", "to", "message", "attachments", "replyTo", "group"],
		required: ["action"],
	},
};

export interface ProviderValidation {
	readonly nonceFound: boolean;
	readonly toolNames: readonly string[];
	readonly errors: readonly string[];
}

export interface ProviderRequestRecord extends ProviderValidation {
	readonly index: number;
	readonly firstByteNs: string;
	readonly parsedAtNs: string;
	readonly requestLine: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly raw: string;
}

export type ProviderSocketAttemptStatus = "pending" | "complete" | "incomplete" | "malformed" | "socket-error";

/** Socket-level evidence retained even when an HTTP request cannot be parsed. */
export interface ProviderSocketAttempt {
	readonly index: number;
	readonly firstByteNs: string;
	status: ProviderSocketAttemptStatus;
	closedAtNs?: string;
	error?: string;
	raw: string;
	requestIndex?: number;
}

interface CollectorOptions {
	readonly nowNs?: () => bigint;
	readonly port?: number;
}

function objectRecord(value: object): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function collectRawToolNames(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const root = objectRecord(value);
	if (!Array.isArray(root.tools)) return [];
	const names: string[] = [];
	for (const tool of root.tools) {
		if (!tool || typeof tool !== "object") continue;
		const record = objectRecord(tool);
		const direct = record.name;
		const fn = record.function;
		const nested = fn && typeof fn === "object" ? objectRecord(fn).name : undefined;
		if (typeof direct === "string") names.push(direct);
		else if (typeof nested === "string") names.push(nested);
	}
	return names;
}

function collectToolNames(value: unknown): string[] {
	return [...new Set(collectRawToolNames(value))].sort();
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false;
	const sortedActual = [...actual].sort();
	const sortedExpected = [...expected].sort();
	return sortedActual.every((name, index) => name === sortedExpected[index]);
}

function hasDuplicateJsonObjectKeys(json: string): boolean {
	let index = 0;
	const skipWhitespace = () => {
		while (/\s/u.test(json[index] ?? "")) index += 1;
	};
	const parseString = (): string => {
		const start = index;
		index += 1;
		while (index < json.length) {
			if (json[index] === "\\") {
				index += 2;
				continue;
			}
			if (json[index] === '"') {
				index += 1;
				return JSON.parse(json.slice(start, index)) as string;
			}
			index += 1;
		}
		return "";
	};
	const parseValue = (): boolean => {
		skipWhitespace();
		if (json[index] === "{") {
			index += 1;
			const keys = new Set<string>();
			skipWhitespace();
			while (json[index] !== "}") {
				const key = parseString();
				if (keys.has(key)) return true;
				keys.add(key);
				skipWhitespace();
				index += 1;
				if (parseValue()) return true;
				skipWhitespace();
				if (json[index] === ",") {
					index += 1;
					skipWhitespace();
				}
			}
			index += 1;
			return false;
		}
		if (json[index] === "[") {
			index += 1;
			skipWhitespace();
			while (json[index] !== "]") {
				if (parseValue()) return true;
				skipWhitespace();
				if (json[index] === ",") {
					index += 1;
					skipWhitespace();
				}
			}
			index += 1;
			return false;
		}
		if (json[index] === '"') {
			parseString();
			return false;
		}
		while (index < json.length && !/[\s,}\]]/u.test(json[index] ?? "")) index += 1;
		return false;
	};
	return parseValue();
}

function collectToolSchemas(value: unknown): Map<string, Record<string, unknown>> {
	const schemas = new Map<string, Record<string, unknown>>();
	if (!value || typeof value !== "object") return schemas;
	const root = objectRecord(value);
	if (!Array.isArray(root.tools)) return schemas;
	for (const tool of root.tools) {
		if (!tool || typeof tool !== "object") continue;

		const record = objectRecord(tool);
		const fn = record.function && typeof record.function === "object" ? objectRecord(record.function) : undefined;
		const name = typeof record.name === "string" ? record.name : typeof fn?.name === "string" ? fn.name : undefined;
		const parameters = record.parameters ?? fn?.parameters;
		if (name !== undefined && parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
			schemas.set(name, objectRecord(parameters));
		}
	}
	return schemas;
}

export function validateProviderRequest(body: string, nonce: string): ProviderValidation {
	const errors: string[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { nonceFound: false, toolNames: [], errors: ["provider request body is not valid JSON"] };
	}
	if (hasDuplicateJsonObjectKeys(body)) errors.push("provider request body contains duplicate JSON object keys");
	const nonceFound = body.includes(nonce);
	if (!nonceFound) errors.push("provider request body is missing the per-run nonce");
	const toolNames = collectToolNames(parsed);
	const rawToolNames = collectRawToolNames(parsed);
	const toolSchemas = collectToolSchemas(parsed);
	for (const required of REQUIRED_BENCHMARK_TOOLS) {
		if (!toolNames.includes(required)) {
			errors.push(`provider request is missing required tool schema: ${required}`);
			continue;
		}
		if (rawToolNames.filter((name) => name === required).length !== 1) {
			errors.push(`provider request must contain exactly one required tool schema: ${required}`);
			continue;
		}
		const schema = toolSchemas.get(required);
		const properties = schema?.properties;
		const schemaRequired = schema?.required;
		const contract = REQUIRED_BENCHMARK_TOOL_SCHEMAS[required];
		const propertyRecord =
			properties && typeof properties === "object" && !Array.isArray(properties)
				? objectRecord(properties)
				: undefined;
		// JSON Schema treats an absent `required` keyword as "no required
		// properties", so accept a missing array when the contract is empty.
		const requiredArray = Array.isArray(schemaRequired)
			? schemaRequired
			: schemaRequired === undefined
				? []
				: undefined;
		const requiredNames = requiredArray?.filter((name): name is string => typeof name === "string");
		if (
			schema?.type !== "object" ||
			propertyRecord === undefined ||
			!sameNames(Object.keys(propertyRecord), contract.properties) ||
			requiredNames === undefined ||
			requiredNames.length !== requiredArray?.length ||
			new Set(requiredNames).size !== requiredNames.length ||
			!sameNames(requiredNames, contract.required)
		) {
			errors.push(`provider request has an inexact required tool schema: ${required}`);
		}
	}
	return { nonceFound, toolNames, errors };
}

function parseHeaders(text: string): { requestLine: string; headers: Record<string, string> } {
	const [requestLine = "", ...lines] = text.split("\r\n");
	const headers: Record<string, string> = {};
	for (const line of lines) {
		const separator = line.indexOf(":");
		if (separator < 1) continue;
		headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
	}
	return { requestLine, headers };
}

function streamingResponse(): string {
	const chunks = [
		{
			id: "benchmark",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant", content: "benchmark-ok" }, finish_reason: null }],
		},
		{
			id: "benchmark",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	];
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return [
		"HTTP/1.1 200 OK",
		"Content-Type: text/event-stream",
		"Cache-Control: no-cache",
		"Connection: close",
		`Content-Length: ${Buffer.byteLength(body)}`,
		"",
		body,
	].join("\r\n");
}

export class LoopbackProviderCollector {
	private readonly nonce: string;
	private readonly nowNs: () => bigint;
	private readonly requestedPort: number;
	private server: Server | undefined;
	private requestWaiters: Array<(record: ProviderRequestRecord) => void> = [];
	readonly attempts: ProviderSocketAttempt[] = [];
	readonly requests: ProviderRequestRecord[] = [];
	port = 0;

	constructor(nonce: string, options: CollectorOptions = {}) {
		this.nonce = nonce;
		this.nowNs = options.nowNs ?? process.hrtime.bigint;
		this.requestedPort = options.port ?? 0;
	}

	async start(): Promise<void> {
		if (this.server) throw new Error("collector is already running");
		this.server = createServer((socket) => this.handleSocket(socket));
		this.server.listen(this.requestedPort, "127.0.0.1");
		await once(this.server, "listening");
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("collector did not bind a TCP port");
		this.port = address.port;
	}

	async waitForRequest(): Promise<ProviderRequestRecord> {
		const existing = this.requests[0];
		if (existing) return existing;
		return new Promise((resolve) => this.requestWaiters.push(resolve));
	}

	assertSingleValidRequest(): ProviderRequestRecord {
		if (this.attempts.length !== 1) {
			throw new Error(`expected exactly one provider socket attempt, received ${this.attempts.length}`);
		}
		const attempt = this.attempts[0]!;
		if (attempt.status !== "complete") {
			throw new Error(`provider socket attempt did not complete: ${attempt.error ?? attempt.status}`);
		}
		if (this.requests.length !== 1) {
			throw new Error(`expected exactly one parsed provider request, received ${this.requests.length}`);
		}
		const record = this.requests[0]!;
		if (record.errors.length > 0) throw new Error(record.errors.join("; "));
		return record;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		server.close();
		await once(server, "close");
	}

	private handleSocket(socket: Socket): void {
		let bytes = Buffer.alloc(0);
		let attempt: ProviderSocketAttempt | undefined;
		let completed = false;
		const closeAttempt = (status: Exclude<ProviderSocketAttemptStatus, "pending" | "complete">, error: string) => {
			if (!attempt || completed) return;
			completed = true;
			attempt.status = status;
			attempt.error = error;
			attempt.closedAtNs = this.nowNs().toString();
			attempt.raw = bytes.toString("utf8");
		};
		socket.on("data", (chunk) => {
			bytes = Buffer.concat([bytes, chunk]);
			if (!attempt) {
				attempt = {
					index: this.attempts.length,
					firstByteNs: this.nowNs().toString(),
					status: "pending",
					raw: bytes.toString("utf8"),
				};
				this.attempts.push(attempt);
			} else attempt.raw = bytes.toString("utf8");
			if (completed) return;
			const headerEnd = bytes.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const headerText = bytes.subarray(0, headerEnd).toString("utf8");
			const parsedHeaders = parseHeaders(headerText);
			const contentLength = Number(parsedHeaders.headers["content-length"] ?? "0");
			if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
				closeAttempt("malformed", "request has an invalid Content-Length header");
				socket.end();
				return;
			}
			const bodyStart = headerEnd + 4;
			if (bytes.length < bodyStart + contentLength) return;
			completed = true;
			const body = bytes.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
			const validation = validateProviderRequest(body, this.nonce);
			const record: ProviderRequestRecord = {
				index: this.requests.length,
				firstByteNs: attempt.firstByteNs,
				parsedAtNs: this.nowNs().toString(),
				requestLine: parsedHeaders.requestLine,
				headers: parsedHeaders.headers,
				body,
				raw: bytes.subarray(0, bodyStart + contentLength).toString("utf8"),
				...validation,
			};
			this.requests.push(record);
			attempt.status = "complete";
			attempt.closedAtNs = record.parsedAtNs;
			attempt.raw = record.raw;
			attempt.requestIndex = record.index;
			for (const waiter of this.requestWaiters.splice(0)) waiter(record);
			socket.end(streamingResponse());
		});
		socket.on("end", () => {
			closeAttempt("incomplete", "socket closed before the declared request body was complete");
			if (!socket.destroyed) socket.end();
		});
		socket.on("error", (error) => closeAttempt("socket-error", error.message));
		socket.on("close", () =>
			closeAttempt("incomplete", "socket closed before the declared request body was complete"),
		);
	}
}
