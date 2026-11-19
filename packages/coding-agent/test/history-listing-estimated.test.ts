import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";

const PROJECT = resolve("/projects/alpha");
const createdAt = "2026-10-15T00:00:00.000Z";

function sessionText(id: string, entries: readonly SessionEntry[]): string {
	const header = { type: "session", id, version: SESSION_FORMAT_VERSION, createdAt, cwd: PROJECT };
	return `${[header, ...entries].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function message(id: string, text: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: createdAt,
		message: { role: "user", content: text, timestamp },
	};
}

describe("history:// session listing (#5250)", () => {
	it("labels a listed session whose counts come from the two ends of a large file as a lower bound (#5250)", async () => {
		const directory = await mkdtemp(join(tmpdir(), "history-listing-estimated-"));
		try {
			const large = [message("m0", "first question", 1_700_000_000_000)];
			for (let index = 1; index <= 400; index++)
				large.push(message(`m${index}`, `${"filler ".repeat(100)}${index}`, 1_700_000_000_000 + index * 1000));
			await writeFile(join(directory, "large.jsonl"), sessionText("large", large));
			await writeFile(join(directory, "small.jsonl"), sessionText("small", [message("only", "small", 1)]));
			const store = await JsonlSessionStore.open(directory, { scanExisting: false });
			try {
				const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
				const rows = String(await router.read?.("history://sessions"))
					.split("\n")
					.filter((line) => line.startsWith("history://sessions/"));
				const row = (id: string) => rows.find((line) => line.startsWith(`history://sessions/${id} `))?.split(" | ");
				const largeRow = row("large");
				const smallRow = row("small");
				assert.ok(largeRow && smallRow, rows.join("\n"));
				assert.match(largeRow[2]!, /^at least \d+ messages$/);
				assert.ok(largeRow.includes("metadata may be incomplete"), largeRow.join(" | "));
				assert.equal(smallRow[2], "1 messages");
				assert.ok(!smallRow.includes("metadata may be incomplete"), smallRow.join(" | "));
			} finally {
				await store.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
