import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";

import { MULTILINE_WINDOW_NOTE } from "../src/core/tools/history-session.js";
import type { InternalReadSelection, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/history-resume");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const CALL_LIMIT = 200;
const SLOW_TIME_MS = 40;
const CUT_ONLY_BYTES = 910;
function message(id: string, text: string, at: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at },
	};
}

async function addSession(store: MemorySessionStore, id: string, at: number, texts: readonly string[]): Promise<void> {
	await store.create(
		{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(at).toISOString(), cwd: PROJECT },
		texts.map((text, index) => message(`${id}-e${index + 1}`, text, at + index)),
	);
}

function request(pattern: string): InternalSearchRequest {
	return { pattern, ignoreCase: false, literal: false, contextBefore: 0, contextAfter: 0 };
}

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

async function follow(search: (url: string) => Promise<string>, first: string, maxCalls = CALL_LIMIT) {
	const outputs: string[] = [];
	const urls: string[] = [];
	let url: string | undefined = first;
	for (let call = 0; url !== undefined && call < maxCalls; call++) {
		urls.push(url);
		const output = await search(url);
		outputs.push(output);
		url = continuation(output);
	}
	return { outputs, urls, finished: url === undefined };
}

function gated() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

function found(outputs: readonly string[], pattern: RegExp): string[] {
	return outputs.flatMap((output) => [...output.matchAll(pattern)].map((match) => match[1]!));
}

function assertEachOnce(rows: readonly string[], expected: readonly string[], trail: string): void {
	assert.deepEqual(
		rows.filter((row, index) => rows.indexOf(row) !== index),
		[],
		`returned twice; ${trail}`,
	);
	assert.deepEqual([...rows].sort(), [...expected].sort(), trail);
}

function footersPastSessionEnd(outputs: readonly string[]): string[] {
	return outputs.flatMap((output) =>
		output.split("\n").filter((line) => {
			const at = / at entry (\d+) of (\d+) in /.exec(line);
			return at !== null && Number(at[1]) > Number(at[2]);
		}),
	);
}

function matchRows(outputs: readonly string[]): string[] {
	return outputs.flatMap((output) =>
		output.split("\n").filter((line) => /^history:\/\/sessions\/[^:]+:\d+: /.test(line)),
	);
}

describe("history:// continuations keep whole records and positions (#5250)", () => {
	it("a multi-session search resumed in a session after newer sessions appear does not search earlier sessions again (#5250)", async () => {
		for (const added of [1, 2, 3]) {
			const store = new MemorySessionStore();
			for (let n = 1; n <= 6; n++)
				await addSession(
					store,
					`s${n}`,
					BASE + n * 60_000,
					Array.from({ length: 8 }, (_, index) => `needle s${n} e${index + 1}`),
				);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				budget: { bytes: 900 },
			});
			let newer = 0;
			const chain = await follow(async (url) => {
				const output = (await router.search!(url, request("needle"))) ?? "";
				for (let i = 0; i < added; i++) {
					newer++;
					await addSession(store, `new${newer}`, BASE + (100 + newer) * 60_000, ["nothing to find"]);
				}
				return output;
			}, "history://sessions");
			const found = chain.outputs.flatMap((output) =>
				[...output.matchAll(/: (needle s\d+ e\d+)$/gm)].map((m) => m[1]!),
			);
			const trail = `${added} added per call; urls:\n${chain.urls.join("\n")}`;
			assert.ok(
				chain.urls.some((url) => url.includes("session=")),
				trail,
			);
			assert.ok(chain.finished, trail);
			assert.deepEqual(
				found.filter((row, index) => found.indexOf(row) !== index),
				[],
				`matches returned twice; ${trail}`,
			);
		}
	});

	it("a session listing read with a line cursor lists sessions afresh instead of taking over another call's unfinished listing (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 8; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`hello ${n}`]);
		const budgeted = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			budget: { rows: 3 },
		});
		const stopped = (await budgeted.read!("history://sessions")) ?? "";
		assert.match(stopped, /scanned \d+ sessions so far/);
		await store.delete("s1");
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const fromLine = (await whole.read!("history://sessions?cursor=1")) ?? "";
		const fresh = (await whole.read!("history://sessions")) ?? "";
		assert.doesNotMatch(fresh, /history:\/\/sessions\/s1 /);
		assert.equal(fromLine, fresh);
	});

	it("a read continued after its store wait ran out of time names the line that was asked for when it is past the end (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 8; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`hello ${n}`]);
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const budgeted = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			budget: { timeMs: SLOW_TIME_MS, rows: 3 },
		});
		const selections: InternalReadSelection[] = [
			{ ranges: [{ start: 40, end: 42 }] },
			{ ranges: [{ start: 40, end: 42 }], raw: true },
			{ ranges: [{ start: 2, end: 3 }] },
			{ offset: 3, limit: 2 },
		];
		const failures: string[] = [];
		const url = "history://sessions";
		for (const selection of selections) {
			const expected = (await whole.readSelected!(url, selection)) ?? "";
			let output = (await budgeted.readSelected!(url, selection)) ?? "";
			const urls: string[] = [];
			for (let next = continuation(output); next !== undefined && urls.length < 20; next = continuation(output)) {
				urls.push(next);
				output = (await budgeted.readSelected!(next, {})) ?? "";
			}
			if (urls.length === 0 || output !== expected)
				failures.push(
					`${url} ${JSON.stringify(selection)} via ${urls.join(" -> ")}:\n${output}\nexpected:\n${expected}`,
				);
		}
		assert.deepEqual(failures, []);
	});

	it("a multi-session search stops before a later session's first match row that does not fit, instead of cutting it (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 3; n++)
			await addSession(store, `s${n}`, BASE + n * 60_000, [
				`needle in session ${n}: ${"words that make the match row long ".repeat(3)}end ${n}`,
				`needle again in session ${n}: ${"more words for the second match row ".repeat(2)}end ${n}`,
			]);
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const expected = matchRows([(await whole.search!("history://sessions", request("needle"))) ?? ""]).sort();
		assert.equal(expected.length, 6);
		const widest = Math.max(...expected.map((row) => Buffer.byteLength(row) + 1));
		const failures: string[] = [];
		for (let bytes = widest + 700; bytes <= widest + 1300; bytes += 3) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, request("needle"))) ?? "",
				"history://sessions",
			);
			const rows = matchRows(chain.outputs).sort();
			if (!chain.finished || JSON.stringify(rows) !== JSON.stringify(expected))
				failures.push(`${bytes} bytes: ${chain.urls.join(" -> ")}\n${rows.join("\n")}`);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `${bytes} bytes: ${line}`));
		}
		assert.deepEqual(failures, []);
	});

	it("a multi-session search that stops after a session's last match continues with the next session, never past its last entry, and says when it cut that row (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 3; n++)
			await addSession(store, `s${n}`, BASE + n * 60_000, [
				"nothing to find",
				`needle at the end of s${n} ${"z".repeat(300)}`,
			]);
		const failures: string[] = [];
		for (let bytes = 500; bytes <= 1_300; bytes += 2) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, request("needle"))) ?? "",
				"history://sessions",
			);
			const rows = found(chain.outputs, /: needle at the end of (s\d) z+$/gm);
			if (!chain.finished || JSON.stringify([...rows].sort()) !== JSON.stringify(["s1", "s2", "s3"]))
				failures.push(`${bytes} bytes: ${rows.join(",")}; urls:\n${chain.urls.join("\n")}`);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `${bytes} bytes: ${line}`));
		}
		const single = new MemorySessionStore();
		await addSession(single, "s1", BASE, ["nothing to find", `needle at the end of s1 ${"z".repeat(300)}`]);
		const fullRow = `history://sessions/s1:2: needle at the end of s1 ${"z".repeat(300)}`;
		let cutSeen = 0;
		for (let bytes = 150; bytes <= 450; bytes += 10) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => single,
				budget: { bytes },
			});
			const output = (await router.search!("history://sessions", request("needle"))) ?? "";
			if (output.startsWith("[History response cannot fit")) continue;
			const lines = output.split("\n");
			const cut = lines.some((line) => line !== fullRow && line.startsWith("history://sessions/s1:2: needle"));
			if (cut) cutSeen++;
			if (
				Buffer.byteLength(output) > bytes ||
				(cut && !lines.some((line) => line.includes("the byte budget ran out")))
			)
				failures.push(`one session, ${bytes} bytes: ${output}`);
			failures.push(...footersPastSessionEnd([output]).map((line) => `one session, ${bytes} bytes: ${line}`));
		}
		for (let bytes = 500; bytes <= 900; bytes += 10) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => single,
				budget: { bytes },
			});
			const output = (await router.search!("history://", request("needle"))) ?? "";
			if (Buffer.byteLength(output) > bytes || !output.split("\n").includes(fullRow))
				failures.push(`history://, ${bytes} bytes: ${output}`);
			failures.push(...footersPastSessionEnd([output]).map((line) => `history://, ${bytes} bytes: ${line}`));
		}
		assert.deepEqual(failures, []);
		assert.ok(cutSeen > 0, "some budget should cut the only match row");
	});

	it("a multi-session search keeps its place when the session it stopped in gets newer activity and newer sessions appear in the same chain (#5250)", async () => {
		for (const { bytes, slowListing } of [
			{ bytes: 500, slowListing: false },
			{ bytes: 900, slowListing: false },
			{ bytes: 500, slowListing: true },
		]) {
			const store = new MemorySessionStore();
			const lastSeq = new Map<string, number>();
			for (let n = 1; n <= 6; n++) {
				await addSession(
					store,
					`s${n}`,
					BASE + n * 60_000,
					Array.from({ length: 10 }, (_, index) => `needle s${n} e${index + 1}`),
				);
				lastSeq.set(`s${n}`, 10);
			}
			let gate = gated();
			const sessions = slowListing
				? new Proxy(store, {
						get(target, key) {
							if (key === "list")
								return (query: Parameters<MemorySessionStore["list"]>[0]) =>
									(async function* () {
										let listed = 0;
										for await (const summary of target.list(query)) {
											if (listed++ === 1) await gate.opened;
											yield summary;
										}
									})();
							const value = Reflect.get(target, key, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					})
				: store;
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => sessions,
				budget: { bytes, ...(slowListing ? { timeMs: SLOW_TIME_MS } : {}) },
			});
			let clock = BASE + 1_000 * 60_000;
			let newer = 0;
			const chain = await follow(async (url) => {
				const output = (await router.search!(url, request("needle"))) ?? "";
				gate.open();
				gate = gated();
				const pinned = /continue with history:\/\/sessions\?\S*session=(s\d+)/.exec(output)?.[1];
				if (pinned !== undefined) {
					clock += 60_000;
					const seq = lastSeq.get(pinned)!;
					await store.append(pinned, [message(`${pinned}-late-${seq}`, "nothing to find", clock)], {
						expectSeq: seq,
					});
					lastSeq.set(pinned, seq + 1);
				}
				clock += 60_000;
				newer++;
				await addSession(store, `new${newer}`, clock, ["nothing to find"]);
				return output;
			}, "history://sessions");
			gate.open();
			const trail = `${bytes} bytes${slowListing ? ", slow listing" : ""}: urls:\n${chain.urls.join("\n")}`;
			assert.ok(
				chain.urls.some((url) => url.includes("session=")),
				trail,
			);
			assert.ok(chain.finished, trail);
			assertEachOnce(
				found(chain.outputs, /: (needle s\d+ e\d+)$/gm),
				Array.from({ length: 60 }, (_, index) => `needle s${Math.floor(index / 10) + 1} e${(index % 10) + 1}`),
				trail,
			);
		}
	});

	it("a session search continued after a finished session or page keeps its place when searched sessions get newer activity and newer sessions appear (#5250)", async () => {
		for (const { first, slowReads } of [
			{ first: "history://sessions?limit=2", slowReads: false },
			{ first: "history://sessions", slowReads: true },
		]) {
			const store = new MemorySessionStore();
			const lastSeq = new Map<string, number>();
			for (let n = 1; n <= 6; n++) {
				await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n}`]);
				lastSeq.set(`s${n}`, 1);
			}
			const sessions = slowReads
				? new Proxy(store, {
						get(target, key) {
							if (key === "readEntryRange")
								return async (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
									await new Promise((resolve) => setTimeout(resolve, 2 * SLOW_TIME_MS));
									return target.readEntryRange(...args);
								};
							const value = Reflect.get(target, key, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					})
				: store;
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => sessions,
				...(slowReads ? { budget: { timeMs: SLOW_TIME_MS } } : {}),
			});
			let clock = BASE + 1_000 * 60_000;
			let newer = 0;
			const chain = await follow(
				async (url) => {
					const output = (await router.search!(url, request("needle"))) ?? "";
					for (const searched of output.matchAll(/^history:\/\/sessions\/(s\d+):\d+: /gm)) {
						clock += 60_000;
						const id = searched[1]!;
						const seq = lastSeq.get(id)!;
						await store.append(id, [message(`${id}-late-${seq}`, "nothing to find", clock)], { expectSeq: seq });
						lastSeq.set(id, seq + 1);
					}
					clock += 60_000;
					newer++;
					await addSession(store, `new${newer}`, clock, ["nothing to find"]);
					return output;
				},
				first,
				30,
			);
			const trail = `${first}: urls:\n${chain.urls.join("\n")}`;
			assert.ok(chain.urls.length > 2, trail);
			assert.ok(chain.finished, trail);
			assertEachOnce(
				found(chain.outputs, /: (needle s\d+)$/gm),
				["needle s1", "needle s2", "needle s3", "needle s4", "needle s5", "needle s6"],
				trail,
			);
		}
	});

	it("a session search over sessions with the same activity time pages through each of them once as newer sessions appear (#5250)", async () => {
		const store = new MemorySessionStore();
		for (const id of ["s-c", "s-a", "s-e", "s-b", "s-d"])
			await store.create(
				{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
				[message(`${id}-e1`, `needle ${id} one`, BASE), message(`${id}-e2`, `needle ${id} two`, BASE)],
			);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			budget: { bytes: 700 },
		});
		let newer = 0;
		const chain = await follow(async (url) => {
			const output = (await router.search!(url, request("needle"))) ?? "";
			newer++;
			await addSession(store, `new${newer}`, BASE + newer * 60_000, ["nothing to find"]);
			return output;
		}, "history://sessions?limit=1");
		const trail = `urls:\n${chain.urls.join("\n")}`;
		assert.ok(chain.finished, trail);
		assertEachOnce(
			found(chain.outputs, /: (needle s-\w \w+)$/gm),
			["s-a", "s-b", "s-c", "s-d", "s-e"].flatMap((id) => [`needle ${id} one`, `needle ${id} two`]),
			trail,
		);
	});

	it("a session search URL pinned without a position resumes after the pinned session when newer sessions appear or the pinned one moves up (#5250)", async () => {
		for (const change of ["newer sessions", "pinned activity"] as const) {
			const store = new MemorySessionStore();
			for (let n = 1; n <= 4; n++)
				await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n} one`, `needle s${n} two`]);
			if (change === "newer sessions") {
				await addSession(store, "new1", BASE + 100 * 60_000, ["nothing to find"]);
				await addSession(store, "new2", BASE + 101 * 60_000, ["nothing to find"]);
			} else
				await store.append("s3", [message("s3-late", "nothing to find", BASE + 100 * 60_000)], { expectSeq: 2 });
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
			const output =
				(await router.search!("history://sessions?offset=1&session=s3&cursor=2", request("needle"))) ?? "";
			assert.deepEqual(
				found([output], /: (needle s\d \w+)$/gm),
				["needle s3 two", "needle s2 one", "needle s2 two", "needle s1 one", "needle s1 two"],
				`${change}:\n${output}`,
			);
		}
	});

	it("a session search rejects a position it did not give (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(store, "s1", BASE, ["needle"]);
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		for (const url of [
			"history://sessions?after=soon",
			"history://sessions?after=12.34",
			"history://sessions?after=1.x.s1",
		])
			await assert.rejects(
				router.search!(url, request("needle")),
				/history after must be the position a session search gave/,
			);
		assert.match(
			(await router.search!("history://sessions?session=s1&cursor=1&after=12.34", request("needle"))) ?? "",
			/^history:\/\/sessions\/s1:1: needle$/m,
		);
	});

	it("a multi-session search that pins sessions with long ids stays within a small byte budget (#5250)", async () => {
		const bytes = 1800;
		const failures: string[] = [];
		for (const limit of [1, 2, 25]) {
			const store = new MemorySessionStore();
			for (let n = 1; n <= 4; n++)
				await addSession(store, `session-${n}-${"ü".repeat(70)}`, BASE + n * 60_000, [
					`needle ${n} one`,
					`needle ${n} two`,
					`needle ${n} three`,
				]);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, request("needle"))) ?? "",
				`history://sessions?limit=${limit}`,
			);
			for (const output of chain.outputs)
				if (Buffer.byteLength(output) > bytes || output.startsWith("[History response cannot fit"))
					failures.push(`limit ${limit}, ${Buffer.byteLength(output)} bytes:\n${output}`);
			const rows = found(chain.outputs, /: (needle \d \w+)$/gm);
			if (!chain.finished || rows.length !== 12 || new Set(rows).size !== 12)
				failures.push(`limit ${limit}: ${rows.length} rows; urls:\n${chain.urls.join("\n")}`);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `limit ${limit}: ${line}`));
		}
		assert.deepEqual(failures, []);
	});

	it("a session search continued from a long pinned session id stays within the byte budget that returned the continuation (#5250)", async () => {
		const store = new MemorySessionStore();
		for (const x of ["a", "b", "c", "d"]) {
			const id = `${x}.dot.${"ü😀.".repeat(6)}`;
			await store.create(
				{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
				Array.from({ length: 3 }, (_, index) => message(`${id}-${index}`, `needle ${x} ${index + 1}`, BASE)),
			);
		}
		const failures: string[] = [];
		for (const bytes of [700, 701, 720, 750, 800, 1100]) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, { ...request("needle"), literal: true })) ?? "",
				"history://sessions",
				40,
			);
			const oversize = chain.outputs.filter(
				(output) => Buffer.byteLength(output) > bytes || output.startsWith("[History response cannot fit"),
			);
			const rows = found(chain.outputs, /: (needle \w \d)$/gm);
			const wholePage = rows.length === 12 && Buffer.byteLength(chain.outputs.join("\n")) <= bytes;
			if (
				!chain.finished ||
				oversize.length > 0 ||
				rows.length !== 12 ||
				new Set(rows).size !== 12 ||
				(bytes >= 1_100 && !wholePage)
			)
				failures.push(
					`${bytes} bytes: ${rows.length} rows, ${oversize.length} oversize; urls:\n${chain.urls.join("\n")}`,
				);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `${bytes} bytes: ${line}`));
		}
		assert.deepEqual(failures, []);
	});

	it("a multi-line session search that notes its match window stays within each byte budget (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 6; n++)
			await addSession(store, `s${n}`, BASE + n * 60_000, [
				`needle ${n}a`,
				"x".repeat(17_000),
				`needle ${n}b`,
				"x".repeat(17_000),
				`needle ${n}c`,
			]);
		const failures: string[] = [];
		for (let bytes = 600; bytes <= 1_000; bytes += 7) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, request("(?s)needle \\d."))) ?? "",
				"history://sessions",
				40,
			);
			const oversize = chain.outputs.filter(
				(output) => Buffer.byteLength(output) > bytes || output.startsWith("[History response cannot fit"),
			);
			const rows = found(chain.outputs, /: (needle \d\w)$/gm);
			if (!chain.finished || oversize.length > 0 || rows.length !== 18 || new Set(rows).size !== 18)
				failures.push(
					`${bytes} bytes: ${rows.length} rows, ${oversize.length} oversize; urls:\n${chain.urls.join("\n")}`,
				);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `${bytes} bytes: ${line}`));
			if (!chain.outputs[0]!.split("\n").includes(`history://sessions:0: [${MULTILINE_WINDOW_NOTE}]`))
				failures.push(`${bytes} bytes: the first page does not note its match window:\n${chain.outputs[0]}`);
		}
		assert.deepEqual(failures, []);
	});

	it("a session search that cannot fit a whole match row cuts only its text, never the session label (#5250)", async () => {
		const store = new MemorySessionStore();
		const id = `long.${"ü😀.".repeat(20)}`;
		await addSession(store, id, BASE, [`needle one ${"y".repeat(600)}`, "needle two"]);
		await addSession(store, "s-other", BASE - 60_000, ["needle other"]);
		const label = `history://sessions/${id}:`;
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const fullRow = ((await whole.search!("history://sessions", request("needle"))) ?? "")
			.split("\n")
			.find((line) => line.startsWith(`${label}1: `));
		assert.ok(fullRow !== undefined);
		const failures: string[] = [];
		const cutAt: number[] = [];
		let firstShown: number | undefined;
		for (let bytes = 300; bytes <= 1_400; bytes += 2) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				budget: { bytes },
			});
			const output = (await router.search!("history://sessions", request("needle"))) ?? "";
			if (Buffer.byteLength(output) > bytes) failures.push(`${bytes} bytes: ${Buffer.byteLength(output)} returned`);
			if (output.startsWith("[History response cannot fit")) {
				if (firstShown !== undefined)
					failures.push(`${bytes} bytes: no rows, although ${firstShown} bytes showed the first match`);
				continue;
			}
			firstShown ??= bytes;
			const rows = output
				.split("\n")
				.filter((line) => line.startsWith("history://sessions/") && !line.includes(":0: ["));
			for (const row of rows)
				if (!row.startsWith("history://sessions/s-other:") && !/^:\d+: \S/.test(row.slice(label.length - 1)))
					failures.push(`${bytes} bytes: ${row}`);
			const first = rows.find((row) => row.startsWith(`${label}1: `));
			if (first === undefined) failures.push(`${bytes} bytes: the first match row is missing`);
			else if (first !== fullRow) {
				if (!fullRow.startsWith(first)) failures.push(`${bytes} bytes: ${first}`);
				cutAt.push(bytes);
			}
		}
		assert.deepEqual(failures, []);
		assert.ok(cutAt.length > 0, "some budget should show the long first row cut");
		assert.equal(cutAt[0], firstShown, "the smallest budget that shows a row should show the first row cut");
		const cutOnly = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			budget: { bytes: CUT_ONLY_BYTES },
		});
		const output = (await cutOnly.search!("history://sessions", request("needle"))) ?? "";
		assert.ok(!output.startsWith("[History response cannot fit"), output);
		const cutRow = output.split("\n").find((line) => line.startsWith(`${label}1: needle`));
		assert.ok(cutRow !== undefined && cutRow !== fullRow && fullRow.startsWith(cutRow), output);
		assert.match(output, /^history:\/\/sessions:0: \[searched sessions 1-1 of 2; the byte budget ran out /m);
	});

	it("a history:// search with a one- or zero-entry budget does not read more entries than it allows (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(store, "s1", BASE, ["needle in session"]);
		const failures: string[] = [];
		for (const rows of [0, 1]) {
			const calls: string[] = [];
			const counted = new Proxy(store, {
				get(target, key) {
					if (key === "list")
						return (...args: Parameters<MemorySessionStore["list"]>) => {
							calls.push("sessions.list");
							return target.list(...args);
						};
					if (key === "readEntryRange")
						return (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
							calls.push("sessions.readEntryRange");
							return target.readEntryRange(...args);
						};
					if (key === "readHeader")
						return (...args: Parameters<MemorySessionStore["readHeader"]>) => {
							calls.push("sessions.readHeader");
							return target.readHeader(...args);
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => counted,
				budget: { rows },
			});
			const output = (await router.search!("history://", request("needle"))) ?? "";
			const sessionCalls = calls.filter((call) => call.startsWith("sessions.")).length;
			const sessionsSkipped =
				/^history:\/\/sessions:0: \[sessions not searched: the row budget ran out; continue with history:\/\/sessions\]$/m.test(
					output,
				);
			if (rows === 0 && (sessionCalls > 0 || !sessionsSkipped))
				failures.push(`rows ${rows}: ${calls.join(", ")}\n${output}`);
			const sessionsNext = /^history:\/\/sessions[^\n]*continue with (history:\/\/sessions\S*?)\]$/m.exec(
				output,
			)?.[1];
			const sessionChain =
				sessionsNext === undefined
					? undefined
					: await follow(async (url) => (await router.search!(url, request("needle"))) ?? "", sessionsNext, 10);
			if (
				!/^history:\/\/sessions\/s1:1: needle in session$/m.test(
					[output, ...(sessionChain?.outputs ?? [])].join("\n"),
				) ||
				(rows === 1 && sessionCalls === 0)
			)
				failures.push(`rows ${rows}: the session match is not reached\n${output}`);
		}
		assert.deepEqual(failures, []);
	});

	it("a session search pinned to a session that is no longer listed says so and searches the sessions at its offset from their start (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 2; n++)
			await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n} e1`, `needle s${n} e2`, `needle s${n} e3`]);
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const output = (await router.search!("history://sessions?session=gone&cursor=3", request("needle"))) ?? "";
		assert.match(
			output,
			/^history:\/\/sessions:0: \[session gone is no longer listed, so the search could not resume in it; it continued with the sessions after it\]$/m,
		);
		assertEachOnce(
			found([output], /: (needle s\d e\d)$/gm),
			["needle s1 e1", "needle s1 e2", "needle s1 e3", "needle s2 e1", "needle s2 e2", "needle s2 e3"],
			output,
		);
	});

	it("a read whose store wait ran out of time continues with the same cursor or raw selection (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(
			store,
			"s1",
			BASE,
			Array.from({ length: 6 }, (_, index) => `entry ${index + 1}`),
		);
		let gate: ReturnType<typeof gated> | undefined;
		const slowStore = new Proxy(store, {
			get(target, key) {
				if (key === "readHeader")
					return async (id: string) => {
						await gate?.opened;
						return target.readHeader(id);
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
		const budgeted = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => slowStore,
			budget: { timeMs: SLOW_TIME_MS },
		});
		const reads: readonly { readonly url: string; readonly selection: InternalReadSelection }[] = [
			{ url: "history://sessions/s1", selection: { ranges: [{ start: 3, end: 4 }], raw: true } },
			{ url: "history://sessions/s1:2-5:raw", selection: {} },
		];
		const failures: string[] = [];
		for (const { url, selection } of reads) {
			const expected = (await whole.readSelected!(url, selection)) ?? "";
			gate = gated();
			const stopped = (await budgeted.readSelected!(url, selection)) ?? "";
			gate.open();
			gate = undefined;
			const next = continuation(stopped);
			const output = next === undefined ? stopped : ((await whole.readSelected!(next, {})) ?? "");
			if (next === undefined || output !== expected)
				failures.push(`${url} ${JSON.stringify(selection)} -> ${next}:\n${output}\nexpected:\n${expected}`);
		}
		assert.deepEqual(failures, []);
	});
});
