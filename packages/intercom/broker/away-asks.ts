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

/** #4829: a kept question's recipient, when its return address was kept, is only the session that proves it. */
const PROVEN_RECIPIENT = "(target_return_address = '' OR target_return_address = ?)";

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
			CREATE TABLE IF NOT EXISTS live_questions (
				message_id TEXT NOT NULL,
				sender_session_id TEXT NOT NULL,
				target_session_id TEXT NOT NULL,
				sender_return_address TEXT NOT NULL,
				target_return_address TEXT NOT NULL,
				broker_instance TEXT NOT NULL,
				recorded_at INTEGER NOT NULL,
				PRIMARY KEY (message_id, sender_session_id, target_session_id)
			);
			CREATE TABLE IF NOT EXISTS live_held (
				message_id TEXT PRIMARY KEY,
				asker_session_id TEXT NOT NULL,
				asker_return_address TEXT NOT NULL,
				replier_session_id TEXT NOT NULL,
				from_json TEXT NOT NULL,
				message_json TEXT NOT NULL,
				broker_instance TEXT NOT NULL,
				held_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS parked_targets (
				owner_session_id TEXT NOT NULL,
				child_name TEXT NOT NULL,
				child_key TEXT NOT NULL,
				target_session_id TEXT NOT NULL,
				parked_at INTEGER NOT NULL,
				PRIMARY KEY (owner_session_id, target_session_id)
			);
			CREATE TABLE IF NOT EXISTS released_askers (
				asker_return_address TEXT PRIMARY KEY,
				owner_session_id TEXT NOT NULL,
				child_name TEXT NOT NULL,
				kept_at INTEGER NOT NULL
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
		// #4829: added later. A file from an older broker gets the column; an older broker ignores it.
		const columns = this.statement("PRAGMA table_info(away_questions)").all();
		if (!columns.some((column) => column.name === "target_return_address"))
			this.database.exec("ALTER TABLE away_questions ADD COLUMN target_return_address TEXT NOT NULL DEFAULT ''");
		this.adoptLiveFromPreviousBrokers();
		this.purge();
	}

	/** This broker's live routes; another instance's are what a broker that shut down or crashed left behind. */
	private readonly instance = randomUUID();

	/**
	 * #4829: the live asks of a broker that is gone wait like away asks: every one of its sessions is away until it
	 * registers again. Each keeps both peers' return addresses, so only the proven asker or recipient takes it up.
	 */
	private adoptLiveFromPreviousBrokers(): void {
		const foreign = this.statement("SELECT 1 FROM live_questions WHERE broker_instance <> ? LIMIT 1").get(this.instance);
		const foreignHeld = this.statement("SELECT 1 FROM live_held WHERE broker_instance <> ? LIMIT 1").get(this.instance);
		if (foreign === undefined && foreignHeld === undefined) return;
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.statement(
				"INSERT OR REPLACE INTO away_questions (message_id, sender_session_id, target_session_id, sender_return_address, target_return_address, kept_at) SELECT message_id, sender_session_id, target_session_id, sender_return_address, target_return_address, recorded_at FROM live_questions WHERE broker_instance <> ?",
			).run(this.instance);
			this.statement("DELETE FROM live_questions WHERE broker_instance <> ?").run(this.instance);
			this.statement(
				"INSERT OR IGNORE INTO held_messages (message_id, asker_session_id, asker_return_address, replier_session_id, from_json, message_json, held_at) SELECT message_id, asker_session_id, asker_return_address, replier_session_id, from_json, message_json, held_at FROM live_held WHERE broker_instance <> ?",
			).run(this.instance);
			this.statement("DELETE FROM live_held WHERE broker_instance <> ?").run(this.instance);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * #4829: a live ask's route, written when it is recorded so it outlives this broker (a restart or a crash), with the
	 * return addresses its asker and recipient registered with. Only an asker that can prove itself is written.
	 */
	recordLive(question: PendingQuestion, senderReturnAddress: string, targetReturnAddress: string): void {
		this.statement(
			"INSERT OR REPLACE INTO live_questions (message_id, sender_session_id, target_session_id, sender_return_address, target_return_address, broker_instance, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			question.messageId,
			question.senderSessionId,
			question.targetSessionId,
			senderReturnAddress,
			targetReturnAddress,
			this.instance,
			this.now(),
		);
	}

	/** The live route was answered, failed, or moved on: it no longer outlives this broker. */
	forgetLive(question: PendingQuestion): void {
		this.statement(
			"DELETE FROM live_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
		).run(question.messageId, question.senderSessionId, question.targetSessionId);
	}

	/** #4829: a failed-ask message this broker holds for a released subagent, kept for it should this broker go. */
	holdLive(held: HeldAwayMessage, askerReturnAddress: string): void {
		this.statement(
			"INSERT OR IGNORE INTO live_held (message_id, asker_session_id, asker_return_address, replier_session_id, from_json, message_json, broker_instance, held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			held.message.id,
			held.askerSessionId,
			askerReturnAddress,
			held.from.id,
			JSON.stringify(held.from),
			JSON.stringify(held.message),
			this.instance,
			this.now(),
		);
	}

	/** The released subagent took its held failed-ask message from this broker. */
	forgetLiveHeld(messageId: string): void {
		this.statement("DELETE FROM live_held WHERE message_id = ?").run(messageId);
	}

	private statement(sql: string): Statement {
		return this.database.prepare(sql) as unknown as Statement;
	}

	private purge(): void {
		const cutoff = this.now() - this.retentionMs;
		this.statement("DELETE FROM away_questions WHERE kept_at < ?").run(cutoff);
		this.statement("DELETE FROM parked_targets WHERE parked_at < ?").run(cutoff);
		this.statement("DELETE FROM released_askers WHERE kept_at < ?").run(cutoff);
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

	/**
	 * #4765: the questions the released subagent `senderSessionId` asked that are kept while their recipient is away. They
	 * stay here too, so the ask survives a broker restart and a subagent back under its own id.
	 */
	forReleasedAsker(senderSessionId: string): PendingQuestion[] {
		return this.statement(
			"SELECT message_id, target_session_id FROM away_questions WHERE sender_session_id = ? ORDER BY kept_at",
		)
			.all(senderSessionId)
			.map((row) => ({
				messageId: String(row.message_id),
				senderSessionId,
				targetSessionId: String(row.target_session_id),
			}));
	}

	/** The kept question was answered some other way: it no longer waits here. */
	forget(question: PendingQuestion): void {
		this.statement(
			"DELETE FROM away_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
		).run(question.messageId, question.senderSessionId, question.targetSessionId);
	}

	/** The kept question `questionId` that `replierSessionId` answers, if its asker is away. */
	question(
		questionId: string,
		replierSessionId: string,
		replierReturnAddress = "",
	): (PendingQuestion & { readonly senderReturnAddress?: string }) | undefined {
		const row = this.statement(
			`SELECT sender_session_id, sender_return_address FROM away_questions WHERE message_id = ? AND target_session_id = ? AND ${PROVEN_RECIPIENT} LIMIT 1`,
		).get(questionId, replierSessionId, replierReturnAddress);
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
		isConnected: (sessionId: string, returnAddress: string) => boolean,
	): PendingQuestion[] {
		this.adoptLiveFromPreviousBrokers();
		// An asker's routes come back only to the session that proves it is the asker (see `held`), under whatever id it
		// registered with now; a recipient's come back to the id it is asked under, and, when the recipient's return
		// address was kept (#4829), only to the session that proves it.
		const proven = returnAddress ?? "";
		const rows = this.statement(
			`SELECT message_id, sender_session_id, target_session_id, sender_return_address, target_return_address, kept_at FROM away_questions WHERE (sender_return_address <> '' AND sender_return_address = ?) OR (sender_return_address = '' AND sender_session_id = ?) OR (target_session_id = ? AND ${PROVEN_RECIPIENT}) ORDER BY kept_at`,
		).all(proven, sessionId, sessionId, proven);
		const remove = this.statement(
			"DELETE FROM away_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
		);
		const rebind = this.statement(
			"INSERT OR REPLACE INTO away_questions (message_id, sender_session_id, target_session_id, sender_return_address, target_return_address, kept_at) VALUES (?, ?, ?, ?, ?, ?)",
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
			const senderProof = askerBack ? proven : String(row.sender_return_address);
			if (
				!isConnected(question.senderSessionId, senderProof) ||
				!isConnected(question.targetSessionId, String(row.target_return_address))
			) {
				// #4765: an asker back under a new id while its recipient is still away keeps the question under that id, so
				// the recipient's answer to it clears the question and its later end does not fail it again.
				if (question.senderSessionId !== kept.senderSessionId) {
					remove.run(kept.messageId, kept.senderSessionId, kept.targetSessionId);
					rebind.run(
						question.messageId,
						question.senderSessionId,
						question.targetSessionId,
						proven,
						String(row.target_return_address),
						Number(row.kept_at),
					);
				}
				continue;
			}
			remove.run(kept.messageId, kept.senderSessionId, kept.targetSessionId);
			restored.push(question);
		}
		return restored;
	}

	/**
	 * The recipient `target` ended, or can no longer answer: each kept question to it becomes a failed-ask message held
	 * for its away asker. Returns the questions failed.
	 */
	failForTarget(
		target: SessionInfo,
		reason: string,
		idPrefix: string,
		failedElsewhere: (question: PendingQuestion) => boolean,
		targetReturnAddress = "",
	): PendingQuestion[] {
		const rows = this.statement(
			`SELECT message_id, sender_session_id, sender_return_address FROM away_questions WHERE target_session_id = ? AND ${PROVEN_RECIPIENT} ORDER BY kept_at`,
		).all(target.id, targetReturnAddress);
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
			// #4765: a released subagent's owner is handed this failure on its own route, which wakes the subagent.
			if (failedElsewhere(question)) continue;
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
		this.statement(`DELETE FROM away_questions WHERE target_session_id = ? AND ${PROVEN_RECIPIENT}`).run(
			target.id,
			targetReturnAddress,
		);
		return failed;
	}

	/**
	 * #4992: `targetSessionId` was a subagent `ownerSessionId` released as `childName`. The link outlives this broker,
	 * so the asks to that session still end with its owner after a restart, and so do the ones whose asker is away.
	 */
	park(ownerSessionId: string, childName: string, targetSessionId: string): void {
		this.statement(
			"INSERT OR REPLACE INTO parked_targets (owner_session_id, child_name, child_key, target_session_id, parked_at) VALUES (?, ?, ?, ?, ?)",
		).run(ownerSessionId, childName, childName.trim().toLowerCase(), targetSessionId, this.now());
	}

	/**
	 * #4992: the owner left, or dropped `childName`: the kept asks to its released subagents end. Each asker gets a
	 * failed-ask message held until it saves it, whether it is away or connected; the held messages are returned, so a
	 * connected asker is written its own at once.
	 */
	failParked(
		ownerSessionId: string,
		childName: string | undefined,
		reason: (childName: string, targetSessionId: string) => string,
		idPrefix: string,
	): Array<HeldAwayMessage & { readonly askerReturnAddress: string }> {
		const targets =
			childName === undefined
				? this.statement("SELECT child_name, target_session_id FROM parked_targets WHERE owner_session_id = ?").all(
						ownerSessionId,
					)
				: this.statement(
						"SELECT child_name, target_session_id FROM parked_targets WHERE owner_session_id = ? AND child_key = ?",
					).all(ownerSessionId, childName.trim().toLowerCase());
		const failed: Array<HeldAwayMessage & { readonly askerReturnAddress: string }> = [];
		for (const target of targets) {
			const targetSessionId = String(target.target_session_id);
			const name = String(target.child_name);
			const from: SessionInfo = { id: targetSessionId, name, cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: this.now() };
			const rows = this.statement(
				"SELECT message_id, sender_session_id, sender_return_address FROM away_questions WHERE target_session_id = ? ORDER BY kept_at",
			).all(targetSessionId);
			for (const row of rows) {
				const askerReturnAddress = typeof row.sender_return_address === "string" ? row.sender_return_address : "";
				const question = {
					messageId: String(row.message_id),
					senderSessionId: String(row.sender_session_id),
					targetSessionId,
				};
				// An asker with no return address cannot be told; its ask ends with the owner all the same.
				if (askerReturnAddress === "") {
					this.forget(question);
					continue;
				}
				const text = reason(name, targetSessionId);
				const message: Message = {
					// Unguessable, so no other session can name it.
					id: `${idPrefix}:${randomUUID()}`,
					timestamp: this.now(),
					replyTo: question.messageId,
					replyError: text,
					content: { text },
				};
				this.hold({ ...question, senderReturnAddress: askerReturnAddress }, from, message);
				failed.push({ askerSessionId: question.senderSessionId, askerReturnAddress, from, message });
			}
			this.statement("DELETE FROM parked_targets WHERE owner_session_id = ? AND target_session_id = ?").run(
				ownerSessionId,
				targetSessionId,
			);
		}
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
		const released = this.releasedAsker(question.senderReturnAddress);
		if (released !== undefined) this.heldForReleasedAsker(released.ownerSessionId, released.childName);
	}

	private heldForReleasedAsker: (ownerSessionId: string, childName: string) => void = () => {};

	/** #4992: told when a message is held for a released subagent, so its owner wakes it. */
	onHeldForReleasedAsker(listener: (ownerSessionId: string, childName: string) => void): void {
		this.heldForReleasedAsker = listener;
	}

	/**
	 * #4992: the released subagent `childName`, which proves itself by `askerReturnAddress`, is kept by
	 * `ownerSessionId`. The link outlives this broker, so a message held for the subagent after a restart still wakes it.
	 */
	keepReleasedAsker(askerReturnAddress: string, ownerSessionId: string, childName: string): void {
		if (askerReturnAddress === "") return;
		this.statement(
			"INSERT OR REPLACE INTO released_askers (asker_return_address, owner_session_id, child_name, kept_at) VALUES (?, ?, ?, ?)",
		).run(askerReturnAddress, ownerSessionId, childName, this.now());
	}

	/** #4992: the released subagent is back, or no longer kept: a message held for it no longer wakes it. */
	forgetReleasedAsker(askerReturnAddress: string | undefined): void {
		if (askerReturnAddress === undefined || askerReturnAddress === "") return;
		this.statement("DELETE FROM released_askers WHERE asker_return_address = ?").run(askerReturnAddress);
	}

	/** #4992: the released subagent a message held for `askerReturnAddress` must wake, if it is one. */
	releasedAsker(askerReturnAddress: string): { readonly ownerSessionId: string; readonly childName: string } | undefined {
		const row = this.statement(
			"SELECT owner_session_id, child_name FROM released_askers WHERE asker_return_address = ?",
		).get(askerReturnAddress);
		if (row === undefined) return undefined;
		return { ownerSessionId: String(row.owner_session_id), childName: String(row.child_name) };
	}

	/** #4992: whether a message is held for a released subagent `ownerSessionId` keeps as `childName`. */
	hasHeldForReleasedAsker(ownerSessionId: string, childName: string): boolean {
		const key = childName.trim().toLowerCase();
		for (const row of this.statement(
			"SELECT r.child_name FROM released_askers r JOIN held_messages h ON h.asker_return_address = r.asker_return_address WHERE r.owner_session_id = ?",
		).all(ownerSessionId)) {
			if (String(row.child_name).trim().toLowerCase() === key) return true;
		}
		return false;
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
