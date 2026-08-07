/**
 * An in-process stand-in for the Herdr socket server.
 *
 * It speaks the real protocol — one newline-delimited JSON request per
 * connection, one response line — so the reporter under test exercises its real
 * transport rather than a substituted one.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSocketEndpoint } from "../src/extensions/herdr/transport.ts";

export interface RecordedRequest {
	id: string;
	method: string;
	params: Record<string, string | number>;
}

export interface HerdrSocketFixture {
	/** Value to put in `HERDR_SOCKET_PATH`. */
	socketPath: string;
	/** Requests in the order the server read them. */
	requests: RecordedRequest[];
	/** Number of accepted connections, including ones that sent nothing. */
	connectionCount(): number;
	/** Resolve once at least `count` requests have arrived, or reject on timeout. */
	waitForRequests(count: number, timeoutMs?: number): Promise<RecordedRequest[]>;
	close(): Promise<void>;
}

let fixtureCounter = 0;

/** Anything `JSON.parse` can produce, named so the boundary needs no `unknown`. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function parseJson(line: string): JsonValue {
	return JSON.parse(line) as JsonValue;
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert a parsed line into a request, or return undefined when it is not one.
 *
 * Every parameter value is checked, so `RecordedRequest` is built only from
 * values that really are strings or numbers.
 */
function toRecordedRequest(value: JsonValue): RecordedRequest | undefined {
	if (!isJsonObject(value)) return undefined;
	const { id, method, params } = value;
	if (typeof id !== "string" || typeof method !== "string") return undefined;
	if (!isJsonObject(params)) return undefined;
	const recordedParams: Record<string, string | number> = {};
	for (const [key, parameter] of Object.entries(params)) {
		if (typeof parameter === "string" || typeof parameter === "number") recordedParams[key] = parameter;
	}
	return { id, method, params: recordedParams };
}

/**
 * A short socket path.
 *
 * Unix domain sockets cap the path at ~104 bytes on macOS, and the default
 * temp directory there is already most of that, so the directory is created
 * directly under it with a very short prefix.
 */
function allocateSocketPath(): { socketPath: string; cleanupDir: string } {
	fixtureCounter += 1;
	if (process.platform === "win32") {
		return { socketPath: `atomic-herdr-test-${process.pid}-${fixtureCounter}`, cleanupDir: "" };
	}
	const dir = mkdtempSync(join(tmpdir(), "hd-"));
	return { socketPath: join(dir, `s${fixtureCounter}`), cleanupDir: dir };
}

/** Options for the stand-in server. */
export interface HerdrSocketFixtureOptions {
	/**
	 * Acknowledge each request. Default true.
	 *
	 * Set false to model a Herdr that accepts the connection and never replies —
	 * the case that makes the reporter spend its full attempt budget.
	 */
	respond?: boolean;
}

export async function startHerdrSocketFixture(options: HerdrSocketFixtureOptions = {}): Promise<HerdrSocketFixture> {
	const respond = options.respond ?? true;
	const { socketPath, cleanupDir } = allocateSocketPath();
	const endpoint = resolveSocketEndpoint(socketPath);
	const requests: RecordedRequest[] = [];
	let connections = 0;
	const sockets = new Set<net.Socket>();

	const server = net.createServer((socket) => {
		connections += 1;
		sockets.add(socket);
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.trim().length > 0) {
					const request = toRecordedRequest(parseJson(line));
					if (request) requests.push(request);
					if (respond) socket.write(`${JSON.stringify({ id: request?.id ?? "", result: {} })}\n`);
				}
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => resolve());
	});

	return {
		socketPath,
		requests,
		connectionCount: () => connections,
		async waitForRequests(count, timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			while (requests.length < count) {
				if (Date.now() > deadline) {
					throw new Error(`timed out waiting for ${count} requests; saw ${requests.length}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return requests;
		},
		close() {
			for (const socket of sockets) socket.destroy();
			return new Promise<void>((resolve) => {
				server.close(() => {
					if (cleanupDir && existsSync(cleanupDir)) rmSync(cleanupDir, { recursive: true, force: true });
					resolve();
				});
			});
		},
	};
}
