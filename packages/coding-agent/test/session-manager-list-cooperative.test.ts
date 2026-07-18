import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAllSessions, listSessionsFromDir } from "../src/core/session-manager-list.ts";

// The cooperative scanner only yields when a chunk crosses a wall-clock
// threshold (16ms), so on fast machines a whole scan can legitimately finish
// without ever yielding — which made the event-loop probe below flaky
// (deterministically failing on fast Linux CI runners). Force every
// cooperative checkpoint to actually yield so the probe measures the
// checkpoint wiring, not machine speed.
vi.mock("../src/utils/event-loop.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/event-loop.ts")>();
	return {
		...actual,
		yieldToEventLoopIfSlow: async () => {
			await actual.yieldToEventLoop();
		},
	};
});

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-session-list-coop-"));
	tempDirs.push(dir);
	return dir;
}

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2020-01-01T00:00:00.000Z",
		cwd: "/tmp/project",
	});
}

function messageLine(index: number, text: string): string {
	return JSON.stringify({
		type: "message",
		id: `m${index}`,
		parentId: index === 0 ? null : `m${index - 1}`,
		message: { role: index % 2 === 0 ? "user" : "assistant", content: text, timestamp: 1_577_836_800_000 + index },
	});
}

function writeSession(dir: string, id: string, messageLines: number, firstText: string): string {
	const lines = [sessionHeader(id)];
	lines.push(messageLine(0, firstText));
	for (let index = 1; index < messageLines; index += 1) {
		lines.push(messageLine(index, `filler message ${index} with enough text to grow the transcript file size`));
	}
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("session listing cooperative scanning", () => {
	it("parses a large single session file via the cooperative path without dropping entries", async () => {
		const dir = tempDir();
		// >512KiB and >2000 message lines forces the cooperative, yielding parser.
		writeSession(dir, "big", 9_000, "big session first user message");

		const sessions = await listSessionsFromDir(dir);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.id).toBe("big");
		expect(sessions[0]!.messageCount).toBe(9_000);
		expect(sessions[0]!.firstMessage).toBe("big session first user message");
	});

	it("keeps the event loop responsive (concurrent macrotasks run) while scanning a large directory", async () => {
		const dir = tempDir();
		writeSession(dir, "big", 12_000, "large transcript");
		for (let index = 0; index < 30; index += 1) {
			writeSession(dir, `small-${index}`, 3, `small ${index}`);
		}

		// Probe event-loop turns with a self-rescheduling setImmediate pump
		// instead of a 1ms interval: Windows timer resolution is ~15ms, so a
		// fast scan can yield cooperatively yet still finish before a 1ms
		// interval ever fires, failing a ticks>0 assertion spuriously. The
		// yield helper is mocked above to always yield at each checkpoint,
		// so at least one pump turn is guaranteed regardless of scan speed.
		let ticks = 0;
		let pumping = true;
		const pump = (): void => {
			if (!pumping) return;
			ticks += 1;
			setImmediate(pump);
		};
		setImmediate(pump);
		try {
			const sessions = await listAllSessions(dir);
			expect(sessions.length).toBe(31);
		} finally {
			pumping = false;
		}
		// The scan yielded to the loop, so the concurrent macrotask got turns.
		expect(ticks).toBeGreaterThan(0);
	});

	it("reports incremental progress across every scanned file", async () => {
		const dir = tempDir();
		const fileCount = 40;
		for (let index = 0; index < fileCount; index += 1) {
			writeSession(dir, `s-${index}`, 2, `session ${index}`);
		}

		const progressEvents: Array<{ loaded: number; total: number }> = [];
		const sessions = await listSessionsFromDir(dir, (loaded, total) => {
			progressEvents.push({ loaded, total });
		});

		expect(sessions).toHaveLength(fileCount);
		expect(progressEvents.length).toBe(fileCount);
		const last = progressEvents.at(-1)!;
		expect(last.loaded).toBe(fileCount);
		expect(last.total).toBe(fileCount);
	});
});
