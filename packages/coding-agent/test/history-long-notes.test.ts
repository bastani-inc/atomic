import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";

const CWD = resolve(`/projects/${Array(20).fill("界".repeat(50)).join("/")}`);
const SCOPES = [
	{ name: "Unicode", cwd: CWD },
	{
		name: "Unicode and spaces",
		cwd: resolve(
			`/projects/${Array(20)
				.fill(`${" ".repeat(147)}界`)
				.join("/")}`,
		),
	},
];
const BASE = Date.parse("2026-11-01T00:00:00Z");
const BYTES = 40_000;

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

async function session(text: string, cwd = CWD) {
	const store = new MemorySessionStore();
	await store.create({ id: "long-scope", version: 4, createdAt: new Date(BASE).toISOString(), cwd }, [
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date(BASE).toISOString(),
			message: { role: "user", content: text, timestamp: BASE },
		},
	]);
	return store;
}

describe("history continuation notes stay inside the byte budget (#5250)", () => {
	it.each(SCOPES)("resumes scoped reads losslessly ($name)", async ({ cwd }) => {
		const text = "z".repeat(80_000);
		const store = await session(text, cwd);
		try {
			const router = createHistoryRouter({ cwd: "/project", sessionStore: () => store });
			let url: string | undefined = `history://sessions/long-scope?project=${encodeURIComponent(cwd)}:1-1`;
			const pieces: string[] = [];
			for (let page = 0; url !== undefined && page < 20; page++) {
				const output = (await router.readSelected!(url, {})) ?? "";
				assert.ok(Buffer.byteLength(output) <= BYTES, `read returned ${Buffer.byteLength(output)} bytes`);
				pieces.push(...output.split("\n").filter((line) => /^z+$/.test(line)));
				url = continuation(output);
				if (url !== undefined) {
					assert.equal(new URL(url.replace(/:1-1$/, "")).searchParams.get("project"), cwd);
					assert.match(url, /:1-1$/);
				}
			}
			assert.equal(url, undefined, "the read reached the end");
			assert.equal(
				pieces.reduce((sum, piece) => sum + piece.length, 0),
				text.length,
			);
			assert.equal(pieces.join(""), text);
		} finally {
			await store.close();
		}
	});

	it.each(SCOPES)("resumes scoped searches without skipping matches ($name)", async ({ cwd }) => {
		const count = 12;
		const store = await session(
			Array.from({ length: count }, (_, index) => `needle-${index + 1} ${"x".repeat(5000)}`).join("\n"),
			cwd,
		);
		try {
			const router = createHistoryRouter({ cwd: "/project", sessionStore: () => store });
			let url: string | undefined = `history://sessions/long-scope?project=${encodeURIComponent(cwd)}:1-1`;
			const found: number[] = [];
			for (let page = 0; url !== undefined && page < 20; page++) {
				const output =
					(await router.search!(url, {
						pattern: "needle-",
						ignoreCase: false,
						literal: false,
						contextBefore: 0,
						contextAfter: 0,
					})) ?? "";
				assert.ok(Buffer.byteLength(output) <= BYTES, `search returned ${Buffer.byteLength(output)} bytes`);
				for (const match of output.matchAll(/:1: needle-(\d+)/g)) found.push(Number(match[1]));
				url = continuation(output);
				if (url !== undefined) {
					assert.equal(new URL(url.replace(/:1-1$/, "")).searchParams.get("project"), cwd);
					assert.match(url, /:1-1$/);
				}
			}
			assert.equal(url, undefined, "the search reached the end");
			assert.deepEqual(
				found,
				Array.from({ length: count }, (_, index) => index + 1),
			);
		} finally {
			await store.close();
		}
	});

	it("returns a compact diagnostic when continuation notes cannot fit instead of truncating their URLs", async () => {
		const store = await session("z".repeat(80_000));
		try {
			const bytes = 8000;
			const router = createHistoryRouter({
				cwd: "/project",
				sessionStore: () => store,
				budget: { bytes },
			});
			const url = `history://sessions/long-scope?project=${encodeURIComponent(CWD)}:1-1`;
			const read = (await router.readSelected!(url, {})) ?? "";
			const search =
				(await router.search!(url, {
					pattern: "z",
					ignoreCase: false,
					literal: true,
					contextBefore: 0,
					contextAfter: 0,
				})) ?? "";
			for (const output of [read, search]) {
				assert.ok(Buffer.byteLength(output) <= bytes, `diagnostic returned ${Buffer.byteLength(output)} bytes`);
				assert.match(output, /byte budget/);
				assert.match(output, /shorter URL|larger byte budget/);
				assert.doesNotMatch(output, /history:\/\//);
			}
		} finally {
			await store.close();
		}
	});
});
