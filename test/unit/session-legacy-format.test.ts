import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionFormatVersionError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";

type LegacyVersion = 1 | 2 | 3;

const created = "2025-06-01T10:00:00.000Z";
const assistant = (text: string, timestamp: number) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-5",
	usage: {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp,
});

function legacyLines(version: LegacyVersion, cwd: string, id: string): object[] {
	const header = {
		type: "session",
		...(version === 1 ? {} : { version }),
		id,
		timestamp: created,
		cwd,
		...(version === 3 ? { parentSession: "parent-session" } : {}),
	};
	const records = [
		{
			type: "message",
			timestamp: "2025-06-01T10:00:01.000Z",
			message: { role: "user", content: `remember the code word for v${version}`, timestamp: 1748772001000 },
		},
		{
			type: "message",
			timestamp: "2025-06-01T10:00:02.000Z",
			message: assistant(`The code word for v${version} is noted.`, 1748772002000),
		},
		...(version === 1
			? []
			: [
					{
						type: "message",
						timestamp: "2025-06-01T10:00:03.000Z",
						message: {
							role: version === 2 ? "hookMessage" : "custom",
							customType: "legacy-hook",
							content: "hook context",
							display: true,
							timestamp: 1748772003000,
						},
					},
					{ type: "session_info", timestamp: "2025-06-01T10:00:04.000Z", name: `Legacy v${version}` },
				]),
	];
	let parentId: string | null = null;
	return [
		header,
		...records.map((record, index) => {
			if (version === 1) return record;
			const id = `e${version}${index}`;
			const linked = { ...record, id, parentId };
			parentId = id;
			return linked;
		}),
	];
}

async function withLegacySession(
	version: LegacyVersion,
	body: (paths: { directory: string; path: string; id: string; content: string }) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), `session-legacy-v${version}-`));
	try {
		const id = `legacy-v${version}`;
		const path = join(directory, `2025-06-01T10-00-00-000Z_${id}.jsonl`);
		const content = `${legacyLines(version, directory, id)
			.map((line) => JSON.stringify(line))
			.join("\n")}\n`;
		await writeFile(path, content);
		await body({ directory, path, id, content });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function diskHeader(content: string): { version?: number; createdAt?: string; timestamp?: string } {
	return JSON.parse(content.slice(0, content.indexOf("\n"))) as {
		version?: number;
		createdAt?: string;
		timestamp?: string;
	};
}

for (const version of [1, 2, 3] as const) {
	it(`lists a pre-format-4 v${version} session for resume without writing it`, async () => {
		await withLegacySession(version, async ({ directory, path, id, content }) => {
			const before = await stat(path);
			const listed = await SessionManager.list(directory, directory);
			const all = await SessionManager.listAll(directory);
			const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
			const summaries = [];
			for await (const summary of store.list({})) summaries.push(summary);
			await store.close();
			for (const sessions of [listed, all]) {
				assert.equal(sessions.length, 1);
				const [info] = sessions;
				assert.equal(info?.id, id);
				assert.equal(info?.path, path);
				assert.equal(info?.name, version === 1 ? undefined : `Legacy v${version}`);
				assert.equal(info?.firstMessage, `remember the code word for v${version}`);
				assert.equal(info?.created.toISOString(), created);
			}
			assert.deepEqual(
				summaries.map((summary) => [summary.id, summary.createdAt, summary.firstMessage]),
				[[id, created, `remember the code word for v${version}`]],
			);
			const after = await stat(path);
			assert.equal(after.mtimeMs, before.mtimeMs);
			assert.equal(await readFile(path, "utf8"), content);
		});
	});

	it(`finds a pre-format-4 v${version} session by id without writing it`, async () => {
		await withLegacySession(version, async ({ directory, path, id, content }) => {
			assert.equal(await SessionManager.findById(directory, id, directory), path);
			assert.equal(await readFile(path, "utf8"), content);
		});
	});

	it(`resumes a pre-format-4 v${version} session, upgrades it to format 4 and accepts appends`, async () => {
		await withLegacySession(version, async ({ path, id }) => {
			const opened = await SessionManager.open(path);
			assert.equal(opened.getSessionId(), id);
			assert.equal(opened.getHeader()?.version, 4);
			assert.equal(opened.getHeader()?.createdAt, created);
			if (version === 3) assert.equal(opened.getHeader()?.parentSessionId, "parent-session");
			const roles = opened.buildSessionContext().messages.map((message) => message.role);
			assert.deepEqual(roles, version === 1 ? ["user", "assistant"] : ["user", "assistant", "custom"]);
			await opened.appendMessage({ role: "user", content: "what was the code word?", timestamp: Date.now() });
			const header = diskHeader(await readFile(path, "utf8"));
			assert.equal(header.version, 4);
			assert.equal(header.createdAt, created);
			assert.equal(header.timestamp, undefined);
			const reopened = await SessionManager.open(path);
			assert.equal(reopened.buildSessionContext().messages.at(-1)?.role, "user");
			assert.equal(reopened.buildSessionContext().messages.length, roles.length + 1);
		});
	});

	it(`continues and resumes by id a pre-format-4 v${version} session`, async () => {
		await withLegacySession(version, async ({ directory, path, id }) => {
			const recent = await SessionManager.continueRecent(directory, directory);
			assert.equal(recent.getSessionId(), id);
			assert.equal(recent.getSessionFile(), path);
			await recent.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
			assert.equal(diskHeader(await readFile(path, "utf8")).version, 4);
			const current = await SessionManager.create(directory, directory);
			const selected = await current.openSessionById(id);
			assert.equal(selected.getSessionId(), id);
			assert.equal(selected.buildSessionContext().messages.at(-1)?.role, "user");
		});
	});

	it(`forks a pre-format-4 v${version} session`, async () => {
		await withLegacySession(version, async ({ directory, id }) => {
			const target = join(directory, "fork");
			const forked = await SessionManager.forkFrom(
				join(directory, `2025-06-01T10-00-00-000Z_${id}.jsonl`),
				directory,
				target,
			);
			assert.equal(forked.getHeader()?.parentSessionId, id);
			assert.equal(forked.buildSessionContext().messages[0]?.role, "user");
		});
	});

	it(`rejects appending to an unloaded pre-format-4 v${version} session`, async () => {
		await withLegacySession(version, async ({ directory, path, id, content }) => {
			const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				await assert.rejects(
					store.append(id, [{ type: "session_info", id: "new", parentId: null, timestamp: created, name: "x" }], {
						expectSeq: 0,
					}),
					SessionFormatVersionError,
				);
			} finally {
				await store.close();
			}
			assert.equal(await readFile(path, "utf8"), content);
		});
	});
}

for (const version of [5, "garbage", null] as const) {
	it(`still rejects session format ${JSON.stringify(version)} on resume`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "session-unknown-format-"));
		try {
			const id = "unknown-format";
			const path = join(directory, `2025-06-01T10-00-00-000Z_${id}.jsonl`);
			const content = `${legacyLines(3, directory, id)
				.map((line, index) => JSON.stringify(index === 0 ? { ...line, version } : line))
				.join("\n")}\n`;
			await writeFile(path, content);
			const rejected = (error: Error): boolean => {
				assert.ok(error instanceof SessionFormatVersionError);
				assert.deepEqual(error.found, version);
				return true;
			};
			await assert.rejects(SessionManager.open(path), rejected);
			assert.deepEqual(await SessionManager.list(directory, directory), []);
			assert.equal(await SessionManager.findById(directory, id, directory), undefined);
			assert.notEqual((await SessionManager.continueRecent(directory, directory)).getSessionId(), id);
			assert.equal(await readFile(path, "utf8"), content);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

const malformedEntries = {
	"null body": () => null,
	"message without message": (version: LegacyVersion) => ({
		type: "message",
		timestamp: "2025-06-01T10:00:05.000Z",
		...(version === 1 ? {} : { id: `bad${version}`, parentId: null }),
	}),
	"message with null message": (version: LegacyVersion) => ({
		type: "message",
		timestamp: "2025-06-01T10:00:05.000Z",
		...(version === 1 ? {} : { id: `bad${version}`, parentId: null }),
		message: null,
	}),
} as const;

for (const version of [1, 2, 3] as const) {
	for (const [variant, malformed] of Object.entries(malformedEntries)) {
		it(`rejects and skips a pre-format-4 v${version} session with a ${variant} entry without writing it`, async () => {
			await withLegacySession(version, async ({ directory, path, id }) => {
				const content = `${[...legacyLines(version, directory, id), malformed(version)]
					.map((line) => JSON.stringify(line))
					.join("\n")}\n`;
				await writeFile(path, content);
				const validId = `valid-v${version}`;
				const validPath = join(directory, `2025-06-01T09-00-00-000Z_${validId}.jsonl`);
				await writeFile(
					validPath,
					`${legacyLines(version, directory, validId)
						.map((line) => JSON.stringify(line))
						.join("\n")}\n`,
				);
				const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
				try {
					await assert.rejects(store.load(id), SessionFormatVersionError);
					await assert.rejects(store.loadFile(path), SessionFormatVersionError);
					const summaries = [];
					for await (const summary of store.list({ cwd: directory })) summaries.push(summary.id);
					assert.deepEqual(summaries, [validId]);
					assert.equal((await store.findMostRecent({ cwd: directory }))?.id, validId);
				} finally {
					await store.close();
				}
				assert.equal(await readFile(path, "utf8"), content);
			});
		});
	}
}
