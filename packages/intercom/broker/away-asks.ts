import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMessage, isSessionInfo } from "./client-message-validation.js";
import type { Message, SessionInfo } from "../types.js";
import type { PendingQuestion } from "./pending-question-index.js";

/** Most asks, and most held messages, kept for sessions that are away; the oldest go first beyond it. */
export const AWAY_ASKS_MAX = 10_000;
/** An away session that has not come back within this long is treated as gone for good: what waits for it is dropped. */
export const AWAY_ASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export { HELD_FOR_AWAY_ASKER_TARGET } from "./held-reply-targets.js";

/** A reply, or a failed-ask message, held for an asker that is closed, delivered once when it registers again. */
export interface HeldAwayMessage {
	readonly askerSessionId: string;
	readonly from: SessionInfo;
	readonly message: Message;
}

interface Statement {
	all(...params: Array<string | number>): Array<Record<string, unknown>>;
	get(...params: Array<string | number>): Record<string, unknown> | undefined;
	run(...params: Array<string | number>): { changes: number | bigint };
}

/**
 * #4751: the asks a session sent or was sent while it is away (closed, restarting, or released between turns), and
 * the replies and failed-ask messages held for an away asker. An ask has no expiry, so these outlive the session's
 * connection and, when a path is given, the broker itself; they are dropped when the session ends for good or has
 * been away longer than {@link AWAY_ASK_RETENTION_MS}. Held messages carry their text: the file is owner-only.
 */
export class AwayAsks {
	private readonly database: DatabaseSync;

	constructor(
		path?: string,
		private readonly now: () => number = Date.now,
		private readonly retentionMs: number = AWAY_ASK_RETENTION_MS,
	) {
		if (path !== undefined) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		}
		this.database = new DatabaseSync(path ?? ":memory:");
		if (path !== undefined && process.platform !== "win32" && existsSync(path)) chmodSync(path, 0o600);
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS away_questions (
				message_id TEXT NOT NULL,
				sender_session_id TEXT NOT NULL,
				target_session_id TEXT NOT NULL,
				sender_return_address TEXT,
				kept_at INTEGER NOT NULL,
				PRIMARY KEY (message_id, sender_session_id, target_session_id)
			);
			CREATE TABLE IF NOT EXISTS held_messages (
				message_id TEXT PRIMARY KEY,
				asker_session_id TEXT NOT NULL,
				asker_return_address TEXT NOT NULL,
				replier_session_id TEXT NOT NULL,
				from_json TEXT NOT NULL,
				message_json TEXT NOT NULL,
				held_at INTEGER NOT NULL
			);
		`);
		this.purge();
	}

	private statement(sql: string): Statement {
		return this.database.prepare(sql) as unknown as Statement;
	}

	private purge(): void {
		const cutoff = this.now() - this.retentionMs;
		this.statement("DELETE FROM away_questions WHERE kept_at < ?").run(cutoff);
		this.statement("DELETE FROM held_messages WHERE held_at < ?").run(cutoff);
		this.statement(
			`DELETE FROM away_questions WHERE rowid NOT IN (SELECT rowid FROM away_questions ORDER BY kept_at DESC LIMIT ${AWAY_ASKS_MAX})`,
		).run();
		this.statement(
			`DELETE FROM held_messages WHERE rowid NOT IN (SELECT rowid FROM held_messages ORDER BY held_at DESC LIMIT ${AWAY_ASKS_MAX})`,
		).run();
	}

	/**
	 * Keep questions whose asker or recipient is away until it is back. `senderReturnAddress`: the away asker's own
	 * session, so a reply is not held for an asker that is already back under another Intercom id.
	 */
	keep(questions: readonly PendingQuestion[], senderReturnAddress?: string): void {
		if (questions.length === 0) return;
		const insert = this.statement(
			"INSERT OR REPLACE INTO away_questions (message_id, sender_session_id, target_session_id, sender_return_address, kept_at) VALUES (?, ?, ?, ?, ?)",
		);
		const at = this.now();
		for (const question of questions)
			insert.run(question.messageId, question.senderSessionId, question.targetSessionId, senderReturnAddress ?? "", at);
		this.purge();
	}

	/**
	 * #4761: the asker `senderSessionId` is away now too. Its questions kept while only their recipient was away, which
	 * have no asker identity yet, take its return address, so a recipient that ends before the asker is back fails them
	 * with a message held for the asker rather than dropping them.
	 */
	markAsker(senderSessionId: string, senderReturnAddress: string | undefined): void {
		if (senderReturnAddress === undefined || senderReturnAddress === "") return;
		this.statement(
			"UPDATE away_questions SET sender_return_address = ? WHERE sender_session_id = ? AND sender_return_address = ''",
		).run(senderReturnAddress, senderSessionId);
	}

	/** The kept question `questionId` that `replierSessionId` answers, if its asker is away. */
	question(
		questionId: string,
		replierSessionId: string,
	): (PendingQuestion & { readonly senderReturnAddress?: string }) | undefined {
		const row = this.statement(
			"SELECT sender_session_id, sender_return_address FROM away_questions WHERE message_id = ? AND target_session_id = ? LIMIT 1",
		).get(questionId, replierSessionId);
		if (typeof row?.sender_session_id !== "string") return undefined;
		const returnAddress = typeof row.sender_return_address === "string" ? row.sender_return_address : "";
		return {
			messageId: questionId,
			senderSessionId: row.sender_session_id,
			targetSessionId: replierSessionId,
			...(returnAddress === "" ? {} : { senderReturnAddress: returnAddress }),
		};
	}

	/** A session is back under its id: its kept questions whose peers are both connected leave this table. */
	restore(
		sessionId: string,
		returnAddress: string | undefined,
		isConnected: (sessionId: string) => boolean,
	): PendingQuestion[] {
		// An asker's routes come back only to the session that proves it is the asker (see `held`), under whatever id it
		// registered with now; a recipient's come back to the id it is asked under.
		const proven = returnAddress ?? "";
		const rows = this.statement(
			"SELECT message_id, sender_session_id, target_session_id, sender_return_address FROM away_questions WHERE (sender_return_address <> '' AND sender_return_address = ?) OR (sender_return_address = '' AND sender_session_id = ?) OR target_session_id = ? ORDER BY kept_at",
		).all(proven, sessionId, sessionId);
		const remove = this.statement(
			"DELETE FROM away_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
		);
		const restored: PendingQuestion[] = [];
		for (const row of rows) {
			const kept = {
				messageId: String(row.message_id),
				senderSessionId: String(row.sender_session_id),
				targetSessionId: String(row.target_session_id),
			};
			const askerBack = proven !== "" && row.sender_return_address === proven;
			const question = askerBack ? { ...kept, senderSessionId: sessionId } : kept;
			if (!isConnected(question.senderSessionId) || !isConnected(question.targetSessionId)) continue;
			remove.run(kept.messageId, kept.senderSessionId, kept.targetSessionId);
			restored.push(question);
		}
		return restored;
	}

	/**
	 * The recipient `target` ended, or can no longer answer: each kept question to it becomes a failed-ask message held
	 * for its away asker. Returns the questions failed.
	 */
	failForTarget(target: SessionInfo, reason: string, idPrefix: string): PendingQuestion[] {
		const rows = this.statement(
			"SELECT message_id, sender_session_id, sender_return_address FROM away_questions WHERE target_session_id = ? ORDER BY kept_at",
		).all(target.id);
		const failed: PendingQuestion[] = [];
		for (const row of rows) {
			const question = {
				messageId: String(row.message_id),
				senderSessionId: String(row.sender_session_id),
				targetSessionId: target.id,
			};
			const returnAddress = typeof row.sender_return_address === "string" ? row.sender_return_address : "";
			// A recipient's own asks to an away session keep no asker identity: only an away asker learns of the end.
			if (returnAddress === "") continue;
			failed.push(question);
			this.hold({ ...question, senderReturnAddress: returnAddress }, target, {
				// Unguessable, so no other session can name it.
				id: `${idPrefix}:${randomUUID()}`,
				timestamp: this.now(),
				replyTo: question.messageId,
				replyError: reason,
				content: { text: reason },
			});
		}
		this.statement("DELETE FROM away_questions WHERE target_session_id = ?").run(target.id);
		return failed;
	}

	/** The asker that proves itself by its return address ended for good: nothing waits for it any more. */
	drop(returnAddress: string | undefined): void {
		if (returnAddress === undefined || returnAddress === "") return;
		this.statement("DELETE FROM away_questions WHERE sender_return_address = ?").run(returnAddress);
		this.statement("DELETE FROM held_messages WHERE asker_return_address = ?").run(returnAddress);
	}

	/**
	 * Hold a message for the away asker of `question`, and close the question: it has its answer (or its failure), so
	 * nothing later fails it again. A message already held under its id is held once.
	 */
	hold(
		question: PendingQuestion & { readonly senderReturnAddress: string },
		from: SessionInfo,
		message: Message,
	): void {
		this.statement(
			"INSERT OR IGNORE INTO held_messages (message_id, asker_session_id, asker_return_address, replier_session_id, from_json, message_json, held_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			message.id,
			question.senderSessionId,
			question.senderReturnAddress,
			from.id,
			JSON.stringify(from),
			JSON.stringify(message),
			this.now(),
		);
		this.statement(
			"DELETE FROM away_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
		).run(question.messageId, question.senderSessionId, question.targetSessionId);
		this.purge();
	}

	/** Whether `messageId` from `replierSessionId` is already held for its asker: a retried reply is answered held again. */
	isHeld(messageId: string, replierSessionId: string): boolean {
		return (
			this.statement("SELECT 1 FROM held_messages WHERE message_id = ? AND replier_session_id = ?").get(
				messageId,
				replierSessionId,
			) !== undefined
		);
	}

	/**
	 * The messages held for this asker, in the order they were held: only to the session that proves it is the asker by
	 * the return address it registered with when it asked, the credential it reclaims its id with.
	 */
	held(askerReturnAddress: string | undefined): HeldAwayMessage[] {
		if (askerReturnAddress === undefined || askerReturnAddress === "") return [];
		const rows = this.statement(
			"SELECT asker_session_id, from_json, message_json FROM held_messages WHERE asker_return_address = ? ORDER BY held_at, rowid",
		).all(askerReturnAddress);
		const held: HeldAwayMessage[] = [];
		for (const row of rows) {
			try {
				const from: unknown = JSON.parse(String(row.from_json));
				const message: unknown = JSON.parse(String(row.message_json));
				if (isSessionInfo(from) && isMessage(message))
					held.push({ askerSessionId: String(row.asker_session_id), from, message });
			} catch {
				// A row that cannot be read is skipped; it ages out with the retention.
			}
		}
		return held;
	}

	/** The verified asker saved a held message: it is not delivered again. */
	release(messageId: string, askerReturnAddress: string | undefined): void {
		if (askerReturnAddress === undefined || askerReturnAddress === "") return;
		this.statement("DELETE FROM held_messages WHERE message_id = ? AND asker_return_address = ?").run(
			messageId,
			askerReturnAddress,
		);
	}

	close(): void {
		this.database.close();
	}
}
