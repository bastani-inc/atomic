import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SessionEntry } from "../../session-manager-types.ts";
import {
	SessionConflictError,
	SessionExistsError,
	SessionIdMismatchError,
	SessionInvalidTextError,
	SessionInvalidTimestampError,
	SessionNotFoundError,
	type SessionTextField,
	StoreClosedError,
} from "./errors.js";
import { SESSION_FORMAT_VERSION, type SessionRecordHeader, type SessionStore, type SessionSummary } from "./types.js";

export interface SessionStoreConformanceRunner {
	describe(name: string, body: () => void): void;
	it(name: string, body: () => Promise<void>): void;
}

export interface SessionStoreConformanceSubject {
	store: SessionStore;
	reopen(): Promise<SessionStore>;
}

export type WithSessionStore = (body: (subject: SessionStoreConformanceSubject) => Promise<void>) => Promise<void>;

type Reload = (store: SessionStore) => Promise<SessionStore>;

const createdAt = "2026-10-15T00:00:00.000Z";

function header(id = "session"): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt, cwd: "/project" };
}

function message(id: string, text: string, timestamp = Date.parse(createdAt)): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	};
}

async function collect(store: SessionStore, query = {}): Promise<SessionSummary[]> {
	const summaries: SessionSummary[] = [];
	for await (const summary of store.list(query)) summaries.push(summary);
	return summaries;
}

function notFound(sessionId: string): (error: Error) => boolean {
	return (error) => {
		assert.ok(error instanceof SessionNotFoundError);
		assert.equal(error.sessionId, sessionId);
		return true;
	};
}

function conflict(sessionId: string, expectedSeq: number, actualSeq: number): (error: Error) => boolean {
	return (error) => {
		assert.ok(error instanceof SessionConflictError);
		assert.equal(error.sessionId, sessionId);
		assert.equal(error.expectedSeq, expectedSeq);
		assert.equal(error.actualSeq, actualSeq);
		return true;
	};
}

function invalidText(
	field: SessionTextField,
	reason: "nul-character" | "ill-formed-unicode",
): (error: Error) => boolean {
	return (error) => {
		assert.ok(error instanceof SessionInvalidTextError);
		assert.equal(error.field, field);
		assert.equal(error.reason, reason);
		return true;
	};
}

export function registerSessionStoreConformance(
	runner: SessionStoreConformanceRunner,
	name: string,
	withSubject: WithSessionStore,
): void {
	for (const reopen of [false, true]) {
		runner.describe(`${name}${reopen ? " (reopen)" : ""}`, () => {
			const check = (title: string, body: (store: SessionStore, reload: Reload) => Promise<void>): void => {
				runner.it(title, () =>
					withSubject((subject) =>
						body(subject.store, async (store) => {
							if (!reopen) return store;
							await store.close();
							return subject.reopen();
						}),
					),
				);
			};

			check("creates atomically and rejects duplicate sessions without changing data", async (store, reload) => {
				const entries = [message("first", "hello")];
				assert.deepEqual(await store.create(header(), entries), { lastSeq: 1 });
				store = await reload(store);
				await assert.rejects(store.create({ ...header(), cwd: "changed" }, []), (error: Error) => {
					assert.ok(error instanceof SessionExistsError);
					assert.equal(error.sessionId, "session");
					return true;
				});
				assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
			});

			check("preserves append order as the reopened leaf and allows shared entry IDs", async (store, reload) => {
				const first = message("shared", "first");
				const second = message("second", "second");
				const third = { ...message("third", "third"), parentId: "shared" };
				await store.create(header(), [first]);
				await store.create(header("other"), [first]);
				store = await reload(store);
				assert.deepEqual(await store.append("session", [second, third], { expectSeq: 1 }), { lastSeq: 3 });
				store = await reload(store);
				const snapshot = await store.load("session");
				assert.deepEqual(snapshot.entries, [first, second, third]);
				assert.equal(snapshot.entries.at(-1)?.id, "third");
				assert.equal(snapshot.lastSeq, 3);
				assert.deepEqual((await store.load("other")).entries, [first]);
			});

			check("rejects stale append and replace without partial writes", async (store, reload) => {
				await store.create(header(), [message("first", "first")]);
				store = await reload(store);
				const before = await store.load("session");
				await assert.rejects(
					store.append("session", [message("bad", "bad")], { expectSeq: 0 }),
					conflict("session", 0, 1),
				);
				await assert.rejects(
					store.replace("session", { ...header(), internal: true }, [], { expectSeq: 0 }),
					conflict("session", 0, 1),
				);
				store = await reload(store);
				assert.deepEqual(await store.load("session"), before);
			});

			check("admits only one of two writers using the same sequence", async (store, reload) => {
				await store.create(header(), []);
				const attempts = await Promise.allSettled([
					store.append("session", [message("a", "a")], { expectSeq: 0 }),
					store.append("session", [message("b", "b")], { expectSeq: 0 }),
				]);
				assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
				const rejected = attempts.find((result) => result.status === "rejected");
				assert.ok(rejected?.status === "rejected");
				assert.ok(rejected.reason instanceof SessionConflictError);
				conflict("session", 0, 1)(rejected.reason);
				store = await reload(store);
				assert.equal((await store.load("session")).lastSeq, 1);
			});

			check("replaces header and entries including parent and workflow metadata", async (store, reload) => {
				await store.create(header(), [message("old", "old")]);
				store = await reload(store);
				const replacement: SessionRecordHeader = {
					...header(),
					internal: true,
					parentSessionId: "parent",
					workflow: { runId: "run", stageId: "stage", stageName: " Stage " },
				};
				const entries = [message("new", "new"), message("last", "last")];
				assert.deepEqual(await store.replace("session", replacement, entries, { expectSeq: 1 }), { lastSeq: 2 });
				store = await reload(store);
				assert.deepEqual(await store.readHeader("session"), replacement);
				assert.deepEqual(await store.load("session"), { header: replacement, entries, lastSeq: 2 });
			});

			check("rejects replacing a session ID without changing either session (#3650)", async (store, reload) => {
				const entries = [message("saved", "saved")];
				await store.create(header(), entries);
				store = await reload(store);
				await assert.rejects(
					store.replace("session", header("replacement"), [message("new", "new")], { expectSeq: 1 }),
					(error: Error) => {
						assert.ok(error instanceof SessionIdMismatchError);
						assert.equal(error.requested, "session");
						assert.equal(error.found, "replacement");
						return true;
					},
				);
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
				assert.equal(await store.readHeader("replacement"), undefined);
				await assert.rejects(store.load("replacement"), notFound("replacement"));
			});

			check("filters exact projects and hides internal sessions in list and most recent", async (store, reload) => {
				await store.create(header("visible"), []);
				await store.create({ ...header("internal"), internal: true }, [
					message("recent", "hidden", Date.parse(createdAt) + 2000),
				]);
				await store.create({ ...header("elsewhere"), cwd: "/project/../project" }, []);
				store = await reload(store);
				assert.deepEqual(
					(await collect(store, { cwd: "/project" })).map((item) => item.id),
					["visible"],
				);
				assert.deepEqual((await collect(store)).map((item) => item.id).sort(), ["elsewhere", "visible"]);
				assert.equal((await collect(store, { cwd: "/project", includeInternal: true })).length, 2);
				assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "visible");
				assert.equal((await store.findMostRecent({ cwd: "/project", includeInternal: true }))?.id, "internal");
				assert.equal(await store.findMostRecent({ cwd: "missing" }), undefined);
			});

			check("lists only sessions whose id starts with an id prefix, ignoring case", async (store, reload) => {
				await store.create(header("0a1b2c3d-0000-4000-8000-000000000001"), []);
				await store.create({ ...header("0A1B2C3D-0000-4000-8000-000000000002"), internal: true }, []);
				await store.create({ ...header("0a1b2c3e-0000-4000-8000-000000000003"), cwd: "/elsewhere" }, []);
				store = await reload(store);
				assert.deepEqual(
					(await collect(store, { idPrefix: "0A1B2C3D", includeInternal: true })).map((item) => item.id).sort(),
					["0A1B2C3D-0000-4000-8000-000000000002", "0a1b2c3d-0000-4000-8000-000000000001"],
				);
				assert.deepEqual((await collect(store, { idPrefix: "0a1b2c3" })).map((item) => item.id).sort(), [
					"0a1b2c3d-0000-4000-8000-000000000001",
					"0a1b2c3e-0000-4000-8000-000000000003",
				]);
				assert.deepEqual(await collect(store, { idPrefix: "ffffffff", includeInternal: true }), []);
			});

			check(
				"computes summaries from messages and the latest metadata without rewriting text",
				async (store, reload) => {
					const time = Date.parse(createdAt) + 1000;
					const entries: SessionEntry[] = [
						message("first", " hello\u0000\ud800 ", time),
						{ type: "session_info", id: "name", parentId: null, timestamp: createdAt, name: " Name " },
						{
							type: "session_summary",
							id: "summary",
							parentId: null,
							timestamp: createdAt,
							summary: " Summary ",
							summarizedThroughId: "first",
						},
						{
							type: "message",
							id: "tool",
							parentId: null,
							timestamp: "2099-01-01T00:00:00Z",
							message: {
								role: "toolResult",
								toolCallId: "call",
								toolName: "test",
								content: [{ type: "text", text: "ignored" }],
								isError: false,
								timestamp: time + 1000,
							},
						},
					];
					await store.create({ ...header(), parentSessionId: "parent" }, entries);
					store = await reload(store);
					const [summary] = await collect(store);
					assert.ok(summary);
					assert.equal(summary.id, "session");
					assert.equal(summary.cwd, "/project");
					assert.equal(summary.parentSessionId, "parent");
					assert.equal(summary.internal, false);
					assert.equal(summary.createdAt, createdAt);
					assert.equal(summary.modifiedAt, new Date(time).toISOString());
					assert.equal(summary.messageCount, 2);
					assert.equal(summary.firstMessage, " hello\u0000\ud800 ");
					assert.equal(summary.searchText, " hello\u0000\ud800 ");
					assert.equal(summary.name, " Name ");
					assert.equal(summary.hasName, true);
					assert.equal(summary.summary, " Summary ");
					assert.equal(summary.summarizedThroughId, "first");
					await store.append(
						"session",
						[
							{ type: "session_info", id: "clear", parentId: null, timestamp: createdAt, name: "" },
							{
								type: "session_summary",
								id: "latest",
								parentId: null,
								timestamp: createdAt,
								summary: "",
								summarizedThroughId: "tool",
							},
						],
						{ expectSeq: 4 },
					);
					store = await reload(store);
					const [cleared] = await collect(store);
					assert.equal(cleared?.name, "");
					assert.equal(cleared?.hasName, true);
					assert.equal(cleared?.summary, "");
					assert.equal(cleared?.summarizedThroughId, "tool");
				},
			);

			check("uses user and assistant text and activity rather than append timestamps", async (store, reload) => {
				const time = Date.parse(createdAt) + 1000;
				const assistant: SessionEntry = {
					type: "message",
					id: "assistant",
					parentId: null,
					timestamp: createdAt,
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "hidden" },
							{ type: "text", text: "answer" },
						],
						api: "openai-responses",
						provider: "openai",
						model: "test",
						stopReason: "stop",
						timestamp: time,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				};
				await store.create(header(), [assistant, message("earlier", "question")]);
				store = await reload(store);
				const [summary] = await collect(store);
				assert.equal(summary?.modifiedAt, new Date(time).toISOString());
				assert.equal(summary?.messageCount, 2);
				assert.equal(summary?.firstMessage, "question");
				assert.equal(summary?.searchText, "answer question");
			});

			for (const timestamp of [-8640000000000001, 8640000000000001]) {
				check(`rejects out-of-range message timestamp ${timestamp} atomically`, async (store, reload) => {
					const entry: SessionEntry = {
						type: "message",
						id: "invalid",
						parentId: null,
						timestamp: createdAt,
						message: { role: "user", content: "invalid time", timestamp },
					};
					const invalid = (error: Error): boolean => {
						assert.ok(error instanceof SessionInvalidTimestampError);
						assert.equal(error.field, "entry.message.timestamp");
						assert.equal(error.value, timestamp);
						assert.equal(error.reason, "out-of-range");
						return true;
					};
					await assert.rejects(store.create(header("rejected"), [message("valid", "valid"), entry]), invalid);
					assert.equal(await store.readHeader("rejected"), undefined);
					const entries = [message("original", "original")];
					await store.create(header(), entries);
					await assert.rejects(
						store.append("session", [message("valid", "valid"), entry], { expectSeq: 1 }),
						invalid,
					);
					await assert.rejects(store.replace("session", header(), [entry], { expectSeq: 1 }), invalid);
					store = await reload(store);
					assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
					assert.equal(await store.readHeader("rejected"), undefined);
					assert.equal((await collect(store)).length, 1);
					assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "session");
				});
			}

			for (const field of ["header.createdAt", "entry.timestamp"] as const) {
				check(`rejects invalid ${field} strings without partial writes`, async (store, reload) => {
					const entries = [message("original", "original")];
					await store.create(header(), entries);
					for (const [value, reason] of [
						["not a timestamp", "unparseable"],
						["2026-10-15", "unparseable"],
						["2026-10-15T00:00:00", "unparseable"],
						["Thu, 15 Oct 2026 00:00:00 GMT", "unparseable"],
						["2026-10-15T00:00:00.1234567890Z", "unparseable"],
						["+02026-10-15T00:00:00Z", "unparseable"],
						["2026-13-01T00:00Z", "unparseable"],
						["2026-10-15T25:00Z", "unparseable"],
						["2026-10-15T00:00+24:00", "unparseable"],
						["-000000-01-01T00:00Z", "unparseable"],
						["2026-13-15T00:00Z", "unparseable"],
						["2026-13-15T00:00:00Z", "unparseable"],
						["2026-10-15T25:00:00Z", "unparseable"],
						["2026-99-15T12:00Z", "unparseable"],
						["2026-10-15T00:00+99:00", "unparseable"],
						["-000000-10-15T00:00:00Z", "unparseable"],
						["+275761-01-01T00:00Z", "out-of-range"],
						["-271822-01-01T00:00Z", "out-of-range"],
						["+275761-13-01T00:00Z", "unparseable"],
						["+275761-01-01T00:00+24:00", "unparseable"],
						["+275760-09-13T00:00:00.001Z", "out-of-range"],
						["-271821-04-19T23:59:59.999Z", "out-of-range"],
					] as const) {
						const invalid = (error: Error): boolean => {
							assert.ok(error instanceof SessionInvalidTimestampError);
							assert.equal(error.field, field);
							assert.equal(error.value, value);
							assert.equal(error.reason, reason);
							return true;
						};
						const invalidHeader =
							field === "header.createdAt" ? { ...header("rejected"), createdAt: value } : header("rejected");
						const invalidEntries: SessionEntry[] =
							field === "entry.timestamp"
								? [{ type: "session_info", id: "invalid", parentId: null, timestamp: value, name: "name" }]
								: entries;
						await assert.rejects(store.create(invalidHeader, invalidEntries), invalid);
						if (field === "entry.timestamp") {
							await assert.rejects(
								store.append("session", [...entries, ...invalidEntries], { expectSeq: 1 }),
								invalid,
							);
						}
						await assert.rejects(
							store.replace("session", invalidHeader, invalidEntries, { expectSeq: 1 }),
							invalid,
						);
						store = await reload(store);
						assert.equal(await store.readHeader("rejected"), undefined);
						assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
						assert.equal((await collect(store)).length, 1);
						assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "session");
					}
				});
			}

			for (const field of ["entry.message.timestamp", "entry.systemMessage.timestamp"] as const) {
				check(`rejects invalid ${field} numbers without partial writes`, async (store, reload) => {
					const entries = [message("original", "original")];
					await store.create(header(), entries);
					for (const timestamp of [NaN, -Infinity, Infinity, -8640000000000001, 8640000000000001]) {
						const entry: SessionEntry =
							field === "entry.message.timestamp"
								? {
										type: "message",
										id: "invalid",
										parentId: null,
										timestamp: createdAt,
										message: {
											role: "toolResult",
											toolCallId: "call",
											toolName: "test",
											content: [],
											isError: false,
											timestamp,
										},
									}
								: {
										type: "compaction",
										id: "invalid",
										parentId: null,
										timestamp: createdAt,
										summary: "summary",
										firstKeptEntryId: null,
										tokensBefore: 0,
										systemMessage: { role: "system", content: "system", timestamp },
									};
						const invalid = (error: Error): boolean => {
							assert.ok(error instanceof SessionInvalidTimestampError);
							assert.equal(error.field, field);
							assert.equal(error.value, timestamp);
							assert.equal(error.reason, "out-of-range");
							return true;
						};
						await assert.rejects(store.create(header("rejected"), [entry]), invalid);
						await assert.rejects(store.append("session", [...entries, entry], { expectSeq: 1 }), invalid);
						await assert.rejects(store.replace("session", header(), [entry], { expectSeq: 1 }), invalid);
						store = await reload(store);
						assert.equal(await store.readHeader("rejected"), undefined);
						assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 1 });
						assert.equal((await collect(store)).length, 1);
						assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "session");
					}
				});
			}

			check(
				"preserves both Date boundaries and orders valid activity instead of append or creation time",
				async (store, reload) => {
					const minimum = -8640000000000000;
					const maximum = 8640000000000000;
					const earliestHeader = { ...header("earliest"), createdAt: "+275760-09-13T00:00:00.000Z" };
					const latestHeader = { ...header("latest"), createdAt: "-271821-04-20T00:00:00.000Z" };
					const earliestEntries = [message("first", "first", minimum)];
					const latestEntries = [
						message("zero", "question", 0),
						message("maximum", "latest", maximum),
						message("minimum", "older", minimum),
					];
					await store.create(earliestHeader, earliestEntries);
					await store.create(latestHeader, latestEntries);
					await store.create(header("fallback"), []);
					store = await reload(store);
					assert.deepEqual(await store.load("earliest"), {
						header: earliestHeader,
						entries: earliestEntries,
						lastSeq: 1,
					});
					assert.deepEqual(await store.load("latest"), {
						header: latestHeader,
						entries: latestEntries,
						lastSeq: 3,
					});
					const summaries = await collect(store);
					assert.equal(summaries.length, 3);
					assert.equal(
						summaries.find((item) => item.id === "earliest")?.modifiedAt,
						new Date(minimum).toISOString(),
					);
					const latest = summaries.find((item) => item.id === "latest");
					assert.equal(latest?.modifiedAt, new Date(maximum).toISOString());
					assert.equal(latest?.messageCount, 3);
					assert.equal(latest?.firstMessage, "question");
					assert.equal(latest?.searchText, "question latest older");
					assert.equal(summaries.find((item) => item.id === "fallback")?.modifiedAt, createdAt);
					assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "latest");
				},
			);

			check(
				"preserves accepted ISO instants verbatim and compares their represented times",
				async (store, reload) => {
					const timestamps = [
						"2026-10-15T01:00+01:00",
						"2026-10-15T01:00:00.123456789+01:00",
						"+002026-10-15T00:00:00.123Z",
						"2026-10-15T02:00:00-01:00",
						"2026-02-30T00:00:00Z",
					];
					for (const [index, timestamp] of timestamps.entries()) {
						const storedHeader = { ...header(String(index)), createdAt: timestamp };
						const entry: SessionEntry = {
							type: "custom",
							id: "entry",
							parentId: null,
							timestamp,
							customType: "data",
							data: { timestamp: "not a date\u0000\ud800" },
						};
						await store.create(storedHeader, [entry]);
						store = await reload(store);
						assert.deepEqual(await store.load(storedHeader.id), {
							header: storedHeader,
							entries: [entry],
							lastSeq: 1,
						});
					}
					const summaries = await collect(store);
					for (const [index, timestamp] of timestamps.entries()) {
						assert.equal(summaries.find((item) => item.id === String(index))?.modifiedAt, timestamp);
					}
					assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "3");
				},
			);

			check(
				"keeps compaction system messages optional and preserves valid timestamp boundaries",
				async (store, reload) => {
					const compaction: SessionEntry = {
						type: "compaction",
						id: "omitted",
						parentId: null,
						timestamp: createdAt,
						summary: "summary",
						firstKeptEntryId: null,
						tokensBefore: 0,
					};
					const entries: SessionEntry[] = [
						compaction,
						...[-8640000000000000, 8640000000000000].map((timestamp) => ({
							...compaction,
							id: String(timestamp),
							systemMessage: { role: "system" as const, content: "system", timestamp },
						})),
					];
					await store.create(header(), entries);
					store = await reload(store);
					assert.deepEqual(await store.load("session"), { header: header(), entries, lastSeq: 3 });
					const [summary] = await collect(store);
					assert.equal(summary?.modifiedAt, createdAt);
					assert.equal(summary?.messageCount, 0);
					assert.equal((await store.findMostRecent({ cwd: "/project" }))?.id, "session");
				},
			);

			check("preserves empty values, duplicate entries and absent optional fields", async (store, reload) => {
				const emptyHeader = { ...header(""), cwd: "", createdAt: "2026-10-15T01:00+01:00" };
				assert.deepEqual(await store.create(emptyHeader, []), { lastSeq: 0 });
				assert.deepEqual(await store.append("", [], { expectSeq: 0 }), { lastSeq: 0 });
				store = await reload(store);
				const [summary] = await collect(store, { cwd: "" });
				assert.ok(summary);
				assert.equal(summary.modifiedAt, emptyHeader.createdAt);
				assert.equal(summary.hasName, false);
				assert.equal(summary.messageCount, 0);
				assert.equal(summary.firstMessage, "(no messages)");
				assert.equal(summary.searchText, "");
				for (const key of ["parentSessionId", "workflow", "name", "summary", "summarizedThroughId"])
					assert.equal(Object.hasOwn(summary, key), false);
				const entry = message("", "");
				await store.append("", [entry, entry], { expectSeq: 0 });
				store = await reload(store);
				assert.deepEqual((await store.load("")).entries, [entry, entry]);
				assert.deepEqual(await store.replace("", emptyHeader, [], { expectSeq: 2 }), { lastSeq: 0 });
			});

			check("rejects invalid structural text atomically with NUL precedence", async (store, reload) => {
				for (const value of ["bad\u0000text", "bad\ud800text", "\ud800\u0000"]) {
					const reason = value.includes("\u0000") ? "nul-character" : "ill-formed-unicode";
					const headers: { field: SessionTextField; value: SessionRecordHeader }[] = [
						{ field: "header.id", value: { ...header(), id: value } },
						{ field: "header.cwd", value: { ...header(), cwd: value } },
						{ field: "header.parentSessionId", value: { ...header(), parentSessionId: value } },
					];
					for (const invalid of headers) {
						await assert.rejects(store.create(invalid.value, []), invalidText(invalid.field, reason));
						assert.deepEqual(await collect(store), []);
					}
				}
				await store.create(header(), []);
				for (const value of ["bad\u0000text", "bad\ud800text", "\ud800\u0000"]) {
					const reason = value.includes("\u0000") ? "nul-character" : "ill-formed-unicode";
					const entries: { field: SessionTextField; value: SessionEntry }[] = [
						{ field: "entry.id", value: { ...message("entry", "body"), id: value } },
						{ field: "entry.parentId", value: { ...message("entry", "body"), parentId: value } },
						{
							field: "summarizedThroughId",
							value: {
								type: "session_summary",
								id: "entry",
								parentId: null,
								timestamp: createdAt,
								summary: "body",
								summarizedThroughId: value,
							},
						},
					];
					for (const invalid of entries) {
						await assert.rejects(
							store.create(header("other"), [invalid.value]),
							invalidText(invalid.field, reason),
						);
						await assert.rejects(
							store.append("session", [message("good", "body"), invalid.value], { expectSeq: 0 }),
							invalidText(invalid.field, reason),
						);
						await assert.rejects(
							store.replace("session", header(), [invalid.value], { expectSeq: 0 }),
							invalidText(invalid.field, reason),
						);
					}
					await assert.rejects(
						store.replace("session", { ...header(), cwd: value }, [], { expectSeq: 0 }),
						invalidText("header.cwd", reason),
					);
				}
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: header(), entries: [], lastSeq: 0 });
				assert.equal(await store.readHeader("other"), undefined);
			});

			check("rejects invalid sessionId arguments without deleting or changing records", async (store, reload) => {
				await store.create(header(), []);
				for (const value of ["bad\u0000text", "bad\ud800text", "\ud800\u0000"]) {
					const reason = value.includes("\u0000") ? "nul-character" : "ill-formed-unicode";
					await assert.rejects(store.load(value), invalidText("sessionId", reason));
					await assert.rejects(store.readHeader(value), invalidText("sessionId", reason));
					await assert.rejects(store.delete(value), invalidText("sessionId", reason));
					await assert.rejects(store.append(value, [], { expectSeq: 0 }), invalidText("sessionId", reason));
					await assert.rejects(
						store.replace(value, header(), [], { expectSeq: 0 }),
						invalidText("sessionId", reason),
					);
					if (store.putBlob !== undefined && store.getBlob !== undefined) {
						await assert.rejects(store.putBlob(value, new Uint8Array([1])), invalidText("sessionId", reason));
						await assert.rejects(store.getBlob(value, "0".repeat(64)), invalidText("sessionId", reason));
					}
				}
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: header(), entries: [], lastSeq: 0 });
			});

			check("preserves NUL and lone surrogates in returned user text", async (store, reload) => {
				const text = " before\u0000\ud800after ";
				const storedHeader = {
					...header(),
					createdAt,
					workflow: { runId: text, stageId: text, stageName: text },
				};
				const entries: SessionEntry[] = [
					{ type: "session_info", id: "name", parentId: null, timestamp: createdAt, name: text },
					{
						type: "session_summary",
						id: "summary",
						parentId: null,
						timestamp: createdAt,
						summary: text,
						summarizedThroughId: "name",
					},
				];
				await store.create(storedHeader, entries);
				store = await reload(store);
				assert.deepEqual(await store.load("session"), { header: storedHeader, entries, lastSeq: 2 });
				const [summary] = await collect(store);
				assert.equal(summary?.name, text);
				assert.equal(summary?.summary, text);
				assert.equal(summary?.createdAt, createdAt);
				assert.equal(summary?.modifiedAt, createdAt);
				assert.deepEqual(summary?.workflow, storedHeader.workflow);
			});

			check(
				"keeps each session's blobs by content hash until the session is deleted (#4379)",
				async (store, reload) => {
					if (store.putBlob === undefined || store.getBlob === undefined) return;
					const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
					const hash = createHash("sha256").update(bytes).digest("hex");
					await assert.rejects(store.putBlob("session", bytes), notFound("session"));
					await store.create(header(), [message("first", "first")]);
					await store.create(header("other"), []);
					const input = Uint8Array.from(bytes);
					assert.deepEqual(await store.putBlob("session", input), { hash, bytes: 256 });
					input.fill(0);
					assert.deepEqual(await store.putBlob("session", bytes), { hash, bytes: 256 });
					const empty = await store.putBlob("session", new Uint8Array());
					assert.deepEqual(empty, { hash: createHash("sha256").digest("hex"), bytes: 0 });
					store = await reload(store);
					const read = await store.getBlob!("session", hash);
					assert.deepEqual(read, bytes);
					read!.fill(1);
					assert.deepEqual(await store.getBlob!("session", hash), bytes);
					assert.deepEqual(await store.getBlob!("session", empty.hash), new Uint8Array());
					assert.equal(await store.getBlob!("session", "0".repeat(64)), undefined);
					assert.equal(await store.getBlob!("other", hash), undefined, "another session does not hold it");
					assert.equal(await store.getBlob!("missing", hash), undefined);
					await store.replace("session", header(), [message("replaced", "replaced")], { expectSeq: 1 });
					await store.append("session", [message("next", "next")], { expectSeq: 1 });
					assert.deepEqual(await store.getBlob!("session", hash), bytes, "writing entries keeps the blobs");
					assert.deepEqual(
						(await store.load("session")).entries.map((entry) => entry.id),
						["replaced", "next"],
						"blobs are not entries",
					);
					await store.delete("session");
					store = await reload(store);
					assert.equal(await store.getBlob!("session", hash), undefined);
					await store.create(header(), []);
					assert.equal(await store.getBlob!("session", hash), undefined, "a session created again holds none");
					await assert.rejects(store.putBlob!("missing", bytes), notFound("missing"));
				},
			);

			check(
				"returns blobs of every size around a megabyte intact, each stored once (#4379)",
				async (store, reload) => {
					if (store.putBlob === undefined || store.getBlob === undefined) return;
					const MiB = 1024 * 1024;
					await store.create(header(), []);
					const stored = new Map<number, { readonly hash: string; readonly bytes: Uint8Array }>();
					for (const size of [1, MiB - 1, MiB, MiB + 1, 2 * MiB, 2.5 * MiB]) {
						const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + size) % 251);
						const blob = await store.putBlob("session", bytes);
						assert.deepEqual(blob, { hash: createHash("sha256").update(bytes).digest("hex"), bytes: size });
						assert.deepEqual(await store.putBlob("session", bytes), blob, `storing ${size} bytes again`);
						stored.set(size, { hash: blob.hash, bytes });
					}
					store = await reload(store);
					for (const [size, { hash, bytes }] of stored) {
						const read = await store.getBlob!("session", hash);
						assert.equal(read?.byteLength, size);
						assert.ok(Buffer.from(read!).equals(Buffer.from(bytes)), `${size} bytes read back as stored`);
					}
					await store.delete("session");
					for (const { hash } of stored.values()) assert.equal(await store.getBlob!("session", hash), undefined);
				},
			);

			check("rejects blob reads and writes after close (#4379)", async (store) => {
				if (store.putBlob === undefined || store.getBlob === undefined) return;
				await store.create(header(), []);
				await store.close();
				await assert.rejects(store.putBlob("session", new Uint8Array([1])), StoreClosedError);
				await assert.rejects(store.getBlob("session", "0".repeat(64)), StoreClosedError);
			});

			check("round-trips NUL characters in JSON entry bodies", async (store, reload) => {
				const entry: SessionEntry = {
					type: "custom",
					id: "entry",
					parentId: null,
					timestamp: createdAt,
					customType: "payload",
					data: { text: "before\u0000after", nested: ["\u0000", { value: "\ud800" }] },
				};
				await store.create(header(), [entry]);
				store = await reload(store);
				assert.deepEqual((await store.load("session")).entries, [entry]);
			});

			check(
				"preserves cancellation reasons before, between and after listing yields (#4319)",
				async (store, reload) => {
					await store.create(header("one"), []);
					await store.create(header("two"), []);
					store = await reload(store);
					const isReason = (reason: unknown) => (error: unknown) => {
						assert.equal(error, reason);
						return true;
					};
					for (const reason of [undefined, new Error("custom reason"), "custom reason"]) {
						const before = new AbortController();
						before.abort(reason);
						const aborted = store.list({ signal: before.signal })[Symbol.asyncIterator]();
						await assert.rejects(aborted.next(), isReason(before.signal.reason));
						const between = new AbortController();
						const iterator = store.list({ signal: between.signal })[Symbol.asyncIterator]();
						assert.equal((await iterator.next()).done, false);
						between.abort(reason);
						await assert.rejects(iterator.next(), isReason(between.signal.reason));
						assert.equal((await iterator.next()).done, true);
						const last = new AbortController();
						const drained = store.list({ signal: last.signal })[Symbol.asyncIterator]();
						assert.equal((await drained.next()).done, false);
						assert.equal((await drained.next()).done, false);
						last.abort(reason);
						await assert.rejects(drained.next(), isReason(last.signal.reason));
						assert.equal((await drained.next()).done, true);
					}
				},
			);

			check("deletes and recreates sessions and reports missing reads and writes", async (store, reload) => {
				await assert.rejects(store.load("missing"), notFound("missing"));
				assert.equal(await store.readHeader("missing"), undefined);
				await assert.rejects(store.append("missing", [], { expectSeq: 0 }), notFound("missing"));
				await assert.rejects(
					store.replace("missing", header("missing"), [], { expectSeq: 0 }),
					notFound("missing"),
				);
				await store.delete("missing");
				await store.create(header(), [message("first", "first")]);
				await store.delete("session");
				store = await reload(store);
				await assert.rejects(store.load("session"), notFound("session"));
				assert.equal(await store.readHeader("session"), undefined);
				assert.deepEqual(await collect(store), []);
				assert.deepEqual(await store.create(header(), []), { lastSeq: 0 });
			});

			check("detaches input and returned records, headers and summaries", async (store, reload) => {
				const original = { ...header(), workflow: { runId: "run", stageId: "stage", stageName: "original" } };
				const entries = [message("first", "original")];
				await store.create(original, entries);
				original.workflow.stageName = "mutated";
				entries[0]!.id = "mutated";
				store = await reload(store);
				const snapshot = await store.load("session");
				assert.equal(snapshot.header.workflow?.stageName, "original");
				assert.equal(snapshot.entries[0]?.id, "first");
				snapshot.entries[0]!.id = "changed";
				if (snapshot.header.workflow) snapshot.header.workflow.stageName = "changed";
				const read = await store.readHeader("session");
				assert.ok(read?.workflow);
				read.workflow.stageName = "changed";
				const [summary] = await collect(store);
				assert.ok(summary?.workflow);
				summary.workflow.stageName = "changed";
				const recent = await store.findMostRecent({ cwd: "/project" });
				assert.ok(recent?.workflow);
				recent.workflow.stageName = "changed";
				assert.equal((await store.load("session")).entries[0]?.id, "first");
				assert.equal((await store.readHeader("session"))?.workflow?.stageName, "original");
			});

			check("rejects every operation after close, including repeated close", async (store, reload) => {
				await store.create(header(), []);
				store = await reload(store);
				const descriptor = store.descriptor;
				const iterator = store.list({})[Symbol.asyncIterator]();
				assert.equal((await iterator.next()).done, false);
				await store.close();
				const isClosed = (error: Error): boolean => {
					assert.ok(error instanceof StoreClosedError);
					assert.equal(error.adapter, descriptor.adapter);
					assert.equal(error.location, descriptor.location);
					return true;
				};
				await assert.rejects(store.close(), isClosed);
				await assert.rejects(store.create(header(), []), isClosed);
				await assert.rejects(store.append("session", [], { expectSeq: 0 }), isClosed);
				await assert.rejects(store.replace("session", header(), [], { expectSeq: 0 }), isClosed);
				await assert.rejects(store.load("session"), isClosed);
				await assert.rejects(store.readHeader("session"), isClosed);
				await assert.rejects(store.delete("session"), isClosed);
				await assert.rejects(store.findMostRecent({ cwd: "/project" }), isClosed);
				await assert.rejects(store.list({})[Symbol.asyncIterator]().next(), isClosed);
				await assert.rejects(iterator.next(), isClosed);
			});
		});
	}
}
