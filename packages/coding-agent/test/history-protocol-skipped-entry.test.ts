import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it, vi } from "vitest";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const RUNAWAY = "a".repeat(35);

vi.mock("../src/core/tools/history-regex-worker.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/tools/history-regex-worker.js")>();
	return {
		...original,
		matchLinesInWorker: async (lines: readonly string[]) =>
			lines.some((line) => line.includes("a".repeat(35)))
				? { matchedIndices: [], timedOut: true }
				: {
						matchedIndices: lines.flatMap((line, index) => (line.includes("safe-tail") ? [index] : [])),
						timedOut: false,
					},
	};
});

const PROJECT = resolve("/projects/history-skipped-entry");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const PATTERN = "(?=a)(a+)+b|safe-tail";

function request(): InternalSearchRequest {
	return { pattern: PATTERN, ignoreCase: false, literal: false, contextBefore: 0, contextAfter: 0 };
}

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

async function storeWith(id: string): Promise<MemorySessionStore> {
	const store = new MemorySessionStore();
	await store.create(
		{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
		[`${RUNAWAY}!`, "safe-tail"].map((text, index) => ({
			type: "message" as const,
			id: `e${index + 1}`,
			parentId: null,
			timestamp: new Date(BASE + index).toISOString(),
			message: { role: "user" as const, content: text, timestamp: BASE + index },
		})),
	);
	return store;
}

describe("history:// searches say which entry ran past the time budget (#5250)", () => {
	it("a search that gives up on an entry says so, fits its byte budget and continues with the next entry (#5250)", async () => {
		const failures: string[] = [];
		for (const [id, budgets] of [
			["x.dot.", [400, 700, 750, 40_000]],
			[`x.dot.${"ü😀.".repeat(6)}`, [400, 700, 750, 40_000]],
			[`x.dot.${"ü😀.".repeat(12)}`, [560, 700, 750, 40_000]],
		] as const) {
			const store = await storeWith(id);
			for (const first of ["history://sessions", `history://sessions/${id}`, "history://"])
				for (const bytes of budgets) {
					const router = createHistoryRouter({
						cwd: PROJECT,
						sessionStore: () => store,
						budget: { bytes },
					});
					const output = (await router.search!(first, request())) ?? "";
					const next = continuation(output);
					let rest = "";
					let url = next;
					let oversize = false;
					for (let call = 0; url !== undefined && call < 5; call++) {
						const page = (await router.search!(url, request())) ?? "";
						oversize ||= Buffer.byteLength(page) > bytes;
						rest += `${page}\n`;
						url = continuation(page);
					}
					const ok =
						Buffer.byteLength(output) <= bytes &&
						/entry 1 (?:in \S+ )?not searched(?:: the pattern ran past the time budget on it)?;/.test(output) &&
						(bytes < 750 || output.includes("not searched: the pattern ran past the time budget on it")) &&
						next !== undefined &&
						/cursor=(?:1\.)?2(?:&|$)/.test(next) &&
						url === undefined &&
						!oversize &&
						!rest.includes("[History response cannot fit") &&
						!rest.includes("not searched") &&
						rest.split("\n").includes(`history://sessions/${id}:2: safe-tail`);
					if (!ok)
						failures.push(
							`${first} at ${bytes} bytes (${Buffer.byteLength(output)}):\n${output}\n-> ${next}\n${rest}`,
						);
				}
		}
		assert.deepEqual(failures, []);
	});
});
