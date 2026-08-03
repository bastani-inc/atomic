/**
 * Minimal interactive-engine child that admits a request and dies in the same
 * turn, so the admission frame is still in the stdout pipe when `exit` fires.
 *
 * The real child cannot be made to do this on demand: it does useful work
 * between admission and death. This fixture pins the ordering rule instead —
 * the host must parse a queued admission frame before it decides that the
 * requests it never answered were never accepted.
 */
import { INTERACTIVE_ENGINE_PROTOCOL_VERSION } from "../../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";

function write(value: object): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

write({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: process.pid });
write({ type: "engine_bound" });
const heartbeat = setInterval(() => write({ type: "engine_heartbeat", at: Date.now() }), 50);
heartbeat.unref?.();

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
	buffer += chunk.toString("utf8");
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		let parsed: { id?: unknown; type?: unknown } | undefined;
		try {
			parsed = JSON.parse(line) as { id?: unknown; type?: unknown };
		} catch {
			continue;
		}
		if (typeof parsed?.id !== "string") continue;
		write({
			type: "engine_request_accepted",
			requestId: parsed.id,
			command: typeof parsed.type === "string" ? parsed.type : "unknown",
		});
		// Hold mode: admit and stay alive, so only the host can end the request.
		if (process.env.ATOMIC_ADMISSION_HOLD === "1") continue;
		// No flush, no await: exit while the frame is still queued.
		process.exit(0);
	}
});
