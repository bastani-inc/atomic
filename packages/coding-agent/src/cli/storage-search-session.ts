import { resolve } from "node:path";
import type { ExtensionToolContext } from "../core/extensions/context-types.ts";
import { renderStorageIdentifiers } from "../core/storage/prefix.js";
import { SESSION_TABLES, SqlSessionStore } from "../core/storage/session/sql-session-store.js";
import { createHistoryRouter } from "../core/tools/history-protocol.ts";
import type { InternalResourceRouter } from "../core/tools/resource-selectors.ts";
import { createSearchToolDefinition } from "../core/tools/search.ts";
import type { StorageCommand } from "./storage-command.js";
import { openSearchDatabase } from "./storage-search-database.js";

type Cursor = readonly [seq: number, match: number, line: number];

function parseCursor(text: string): Cursor | undefined {
	const parts = /^([1-9]\d{0,15})(?:\.(0|[1-9]\d{0,15})(?:\.([1-9]\d{0,15}))?)?$/.exec(text);
	if (!parts || (parts[2] === "0" && !parts[3])) return undefined;
	const cursor: Cursor = [Number(parts[1]), Number(parts[2] ?? 0), Number(parts[3] ?? 0)];
	return cursor.every(Number.isSafeInteger) ? cursor : undefined;
}

function advances([seq, match, line]: Cursor, [nextSeq, nextMatch, nextLine]: Cursor): boolean {
	// The match index starts again at zero in the next slice of the same entry.
	return nextSeq > seq || (nextSeq === seq && (nextLine > line || (nextLine === line && nextMatch > match)));
}

/** Only the built-in provider's leading entry-zero budget note can offer another page. The source never comes from output. */
function budgetCursor(note: string, base: string): string | undefined {
	const prefix = `${base}:0: [searched entries `;
	const link = `; continue with ${base}?cursor=`;
	const end = note.indexOf(link, prefix.length);
	if (!note.startsWith(prefix) || !note.endsWith("]") || end < 0) return undefined;
	if (
		!/^\d+-\d+(?: of \d+)?; the (?:byte|row|time) budget ran out(?:; entry \d+ not searched(?:: the pattern ran past the time budget on it)?)?$/.test(
			note.slice(prefix.length, end),
		)
	)
		return undefined;
	return note.slice(end + link.length, -1);
}

/** Unlike Bun's global console, a Console bound to the stream reports pipe errors through that stream. */
async function printPage(output: { log(line: string): void }, text: string): Promise<boolean> {
	const stdout = process.stdout;
	let failure: Error | undefined;
	const onError = (error: Error) => {
		failure = error;
	};
	stdout.on("error", onError);
	try {
		output.log(text);
		// The empty write is a flush barrier for the log above, not another output record.
		await new Promise<void>((resolve, reject) => stdout.write("", (error) => (error ? reject(error) : resolve())));
		if (failure) throw failure;
		return true;
	} catch (error) {
		if (((failure ?? error) as NodeJS.ErrnoException)?.code === "EPIPE") {
			// The one-shot CLI must not try to flush this broken pipe again on exit.
			stdout.end();
			return false;
		}
		throw error;
	} finally {
		stdout.off("error", onError);
	}
}

export async function searchStoredSession(
	{ file, sessionId, pattern, cursor }: Extract<StorageCommand, { kind: "search-session" }>,
	cwd: string,
	log?: (text: string) => void | Promise<void>,
): Promise<void> {
	if (!sessionId || /[^A-Za-z0-9_-]/.test(sessionId))
		throw new Error(
			"Use a single session ID containing only letters, digits, hyphens or underscores; use ordinary search for other selectors.",
		);
	let position: Cursor | undefined = parseCursor(cursor ?? "1");
	if (!position)
		throw new Error("Use the numeric entry cursor from the printed session URL, not a listing cursor or a range.");
	const path = resolve(cwd, file);
	if (file === ":memory:" || /^(?:[a-z][a-z\d+.-]*:\/\/|file:|[/\\]{2})/i.test(file) || /^[/\\]{2}/.test(path))
		throw new Error("An existing local SQLite session file is required; no configured store is substituted.");
	const output = log
		? undefined
		: (new console.Console({ stdout: process.stdout, ignoreErrors: false }) as Console & Pick<typeof console, "log">);
	const db = await openSearchDatabase(path);
	try {
		const store = await SqlSessionStore.openTranscriptReader(db);
		try {
			// Check the selected transcript, not the database's change counter: unrelated writers can continue.
			// Do not hold a read transaction (and its WAL pages) across an output write or a continuation.
			const table = renderStorageIdentifiers("sessions", SESSION_TABLES).sessions;
			const revision = async () => (await db.get(`SELECT revision FROM ${table} WHERE id = ?`, sessionId))?.revision;
			const initial = await revision();
			if (initial === undefined) throw new Error(`Session not found in the named database: ${sessionId}`);
			const history = createHistoryRouter({ cwd, sessionStore: () => store });
			const search = createSearchToolDefinition(cwd);
			const base = `history://sessions/${sessionId}`;
			for (;;) {
				let note = "";
				const url = cursor === undefined ? base : `${base}?cursor=${cursor}`;
				const router: InternalResourceRouter = {
					async search(target, request) {
						if (target !== url) throw new Error("Unexpected history search scope");
						const raw = await history.search!(target, request);
						note = raw?.split("\n", 1)[0] ?? "";
						return raw;
					},
				};
				// The ordinary search receives exactly the cwd and internal router it uses for this single URL.
				const page = await search.execute("storage-search", { pattern, paths: url }, undefined, undefined, {
					cwd,
					internalResourceRouter: router,
				} as ExtensionToolContext);
				const reopened = await db.refresh();
				if ((await revision()) !== initial)
					throw new Error(
						"The session changed during the search; rerun it or follow the last printed cursor manually.",
					);
				if (reopened) continue;
				const text = page.content[0];
				if (text?.type !== "text") throw new Error("Expected a text page from history search");
				if (log) await log(text.text);
				else if (!(await printPage(output!, text.text))) return;
				// Old rows have no revision until their next write. Their ordinary page and manual URL still work.
				if (
					typeof initial !== "string" ||
					!initial ||
					!note ||
					!(text.text === note || text.text.startsWith(`${note}\n`))
				)
					return;
				cursor = budgetCursor(note, base);
				const next = cursor === undefined ? undefined : parseCursor(cursor);
				if (!next || !advances(position, next)) return;
				position = next;
			}
		} finally {
			await store.close();
		}
	} finally {
		await db.close();
	}
}
