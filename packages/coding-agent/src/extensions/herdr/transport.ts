/**
 * Bounded, silent transport for the Herdr socket.
 *
 * One request per connection: write one line of JSON, take the first response
 * line as the acknowledgement, close. A dead, refusing, or hung socket degrades
 * to silence — nothing here rejects, and no lifecycle path can be blocked by it.
 *
 * Wire success is not semantic acceptance. Herdr acknowledges a request and can
 * still drop it when its sequence is not above the last one it saw for this
 * source, which is why the sequence counter, not the acknowledgement, is what
 * the reporter relies on.
 */

import net from "node:net";
import type { HerdrRequest } from "./types.js";

/** First attempt budget. */
export const FIRST_ATTEMPT_TIMEOUT_MS = 500;

/** Single retry budget. There is no third attempt. */
export const RETRY_ATTEMPT_TIMEOUT_MS = 1500;

/** Resolve the connect target, accounting for Windows named pipes. */
export function resolveSocketEndpoint(socketPath: string, platform: string = process.platform): string {
	return platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

function attempt(endpoint: string, request: HerdrRequest, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener: (() => void) | undefined;

		const finish = (delivered: boolean): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			removeAbortListener?.();
			socket.destroy();
			resolve(delivered);
		};

		let socket: net.Socket;
		try {
			socket = net.createConnection(endpoint);
		} catch {
			resolve(false);
			return;
		}
		socket.on("error", () => finish(false));
		socket.on("connect", () => {
			try {
				socket.write(`${JSON.stringify(request)}\n`);
			} catch {
				finish(false);
			}
		});
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
		socket.on("close", () => finish(false));
		timer = setTimeout(() => finish(false), timeoutMs);
		// The reporter must never hold the process open past its work.
		timer.unref?.();

		if (signal) {
			const onAbort = (): void => finish(false);
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	});
}

/**
 * Send one request, with one bounded retry. Always resolves; never rejects.
 *
 * An aborted signal ends the attempt in flight and skips the retry. A reporter
 * silenced by a non-quit shutdown must stop talking immediately: otherwise its
 * 1500 ms retry opened another connection *after* shutdown returned, and the
 * successor's first report could race stale traffic from a predecessor that was
 * supposed to have gone quiet.
 */
export async function sendHerdrRequest(
	endpoint: string,
	request: HerdrRequest,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return false;
	if (await attempt(endpoint, request, FIRST_ATTEMPT_TIMEOUT_MS, signal)) return true;
	if (signal?.aborted) return false;
	return attempt(endpoint, request, RETRY_ATTEMPT_TIMEOUT_MS, signal);
}

/**
 * The transport shape the reporter depends on, so tests can substitute one.
 *
 * The signal is optional so a substituted transport may ignore it.
 */
export type HerdrTransport = (request: HerdrRequest, signal?: AbortSignal) => Promise<boolean>;

/** Bind {@link sendHerdrRequest} to one socket endpoint. */
export function createSocketTransport(endpoint: string): HerdrTransport {
	return (request, signal) => sendHerdrRequest(endpoint, request, signal);
}
