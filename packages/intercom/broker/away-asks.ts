import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMessage, isSessionInfo } from "./client-message-validation.js";
import type { Message, SessionInfo } from "../types.js";
import type { SavedHandoff } from "./multinode-router.js";
import type { PendingQuestion } from "./pending-question-index.js";

/**
 * #4996: most asks kept for one away recipient. A further one is refused, and its connected asker told at once; nothing
 * kept is evicted to make room. The bound is per recipient, as the shared outbox's is, so one recipient that never comes
 * back cannot refuse every other session's asks for the whole retention. An away asker's own asks, and the replies held
 * for it, need no bound of their own: they were already admitted as live asks, and each held reply replaces its ask.
 */
export const AWAY_ASKS_PER_RECIPIENT_MAX = 1_000;

/** #4996: why an ask to a recipient that went away with a full queue was not kept for it. */
export function awayQueueFullReason(recipientName: string): string {
	return `Session "${recipientName}" went away and its queue of asks waiting for its return is full (limit ${AWAY_ASKS_PER_RECIPIENT_MAX}); this ask was not kept`;
}
/**
 * How long a write waits for another broker's connection to the same file, as while one broker replaces another,
 * before it fails. Short: the wait holds the broker's event loop.
 */
const AWAY_ASKS_BUSY_TIMEOUT_MS = 200;

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
 * been away longer than {@link AWAY_ASK_RETENTION_MS}, never to make room (#4996). Held messages carry their text: the
 * file is owner-only.
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
		if (path !== undefined) this.database.exec(`PRAGMA busy_timeout = ${AWAY_ASKS_BUSY_TIMEOUT_MS}`);
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
			CREATE TABLE IF NOT EXISTS id_handoffs (
				identity TEXT PRIMARY KEY,
				handoff TEXT NOT NULL,
				session_id TEXT NOT NULL,
				alias TEXT NOT NULL,
				alias_token TEXT NOT NULL,
				recovery TEXT NOT NULL,
				at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS id_handoff_holder (
				only INTEGER PRIMARY KEY CHECK (only = 1),
				holder TEXT NOT NULL
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
		// #4997: added later, the same way: whether an ask's peers were both top-level sessions, so it may move brokers.
		for (const table of ["live_questions", "away_questions"]) {
			const tableColumns = this.statement(`PRAGMA table_info(${table})`).all();
			if (!tableColumns.some((column) => column.name === "movable"))
				this.database.exec(`ALTER TABLE ${table} ADD COLUMN movable INTEGER NOT NULL DEFAULT 0`);
		}
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
		this.batch(() => {
			this.statement(
				"INSERT OR REPLACE INTO away_questions (message_id, sender_session_id, target_session_id, sender_return_address, target_return_address, kept_at, movable) SELECT message_id, sender_session_id, target_session_id, sender_return_address, target_return_address, recorded_at, movable FROM live_questions WHERE broker_instance <> ?",
			).run(this.instance);
			this.statement("DELETE FROM live_questions WHERE broker_instance <> ?").run(this.instance);
			this.statement(
				"INSERT OR IGNORE INTO held_messages (message_id, asker_session_id, asker_return_address, replier_session_id, from_json, message_json, held_at) SELECT message_id, asker_session_id, asker_return_address, replier_session_id, from_json, message_json, held_at FROM live_held WHERE broker_instance <> ?",
			).run(this.instance);
			this.statement("DELETE FROM live_held WHERE broker_instance <> ?").run(this.instance);
		});
	}

	private batchDepth = 0;

	/**
	 * #4996: run `work`'s writes as one transaction rather than one commit each, so a departure that holds or keeps many
	 * asks does not stall the broker (each commit waits for the disk). A batch inside a batch joins it. What `work` wrote
	 * before it threw is committed, as it was when each write committed on its own.
	 */
	batch<T>(work: () => T): T {
		if (this.batchDepth > 0) return work();
		this.database.exec("BEGIN IMMEDIATE");
		this.batchDepth = 1;
		let result: T;
		try {
			result = work();
		} catch (error) {
			this.batchDepth = 0;
			this.commit();
			throw error;
		}
		this.batchDepth = 0;
		this.commit();
		return result;
	}

	private commit(): void {
		try {
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
	recordLive(
		question: PendingQuestion,
		senderReturnAddress: string,
		targetReturnAddress: string,
		movable = false,
	): void {
		this.statement(
			"INSERT OR REPLACE INTO live_questions (message_id, sender_session_id, target_session_id, sender_return_address, target_return_address, broker_instance, recorded_at, movable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			question.messageId,
			question.senderSessionId,
			question.targetSessionId,
			senderReturnAddress,
			targetReturnAddress,
			this.instance,
			this.now(),
			movable ? 1 : 0,
		);
	}

	/**
	 * #4997: the kept asks between two top-level sessions, including those a broker that is gone left behind. Either
	 * session may come back on another broker, so with multi-node routing they move to the shared state.
	 */
	movable(): PendingQuestion[] {
		this.adoptLiveFromPreviousBrokers();
		return this.statement(
			"SELECT message_id, sender_session_id, target_session_id FROM away_questions WHERE movable = 1 ORDER BY kept_at",
		)
			.all()
			.map((row) => ({
				messageId: String(row.message_id),
				senderSessionId: String(row.sender_session_id),
				targetSessionId: String(row.target_session_id),
			}));
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

	/**
	 * #5607: the id hand-overs a multi-node broker of this directory gave (`SavedHandoff`), those older than `keepMs`
	 * dropped, taken over by `holder`: from now on only its writes change them, so a broker it replaced writes nothing
	 * over them.
	 */
	takeIdHandoffs(holder: string, keepMs: number): SavedHandoff[] {
		return this.batch(() => {
			this.statement("INSERT OR REPLACE INTO id_handoff_holder (only, holder) VALUES (1, ?)").run(holder);
			this.statement("DELETE FROM id_handoffs WHERE at <= ?").run(this.now() - keepMs);
			return this.statement("SELECT * FROM id_handoffs")
				.all()
				.map((row) => ({
					identity: String(row.identity),
					handoff: String(row.handoff),
					id: String(row.session_id),
					alias: String(row.alias),
					...(row.alias_token === "" ? {} : { aliasToken: String(row.alias_token) }),
					recovery: String(row.recovery),
					at: Number(row.at),
				}));
		});
	}

	/** #5607: keep each identity's id hand-over, or drop it (`undefined`), while `holder` still holds them. */
	putIdHandoffs(holder: string, changes: ReadonlyArray<readonly [string, SavedHandoff | undefined]>): void {
		const holds = "EXISTS (SELECT 1 FROM id_handoff_holder WHERE holder = ?)";
		this.batch(() => {
			for (const [identity, handoff] of changes)
				if (handoff === undefined)
					this.statement(`DELETE FROM id_handoffs WHERE identity = ? AND ${holds}`).run(identity, holder);
				else
					this.statement(
						`INSERT INTO id_handoffs (identity, handoff, session_id, alias, alias_token, recovery, at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${holds} ON CONFLICT (identity) DO UPDATE SET handoff = excluded.handoff, session_id = excluded.session_id, alias = excluded.alias, alias_token = excluded.alias_token, recovery = excluded.recovery, at = excluded.at`,
					).run(
						identity,
						handoff.handoff,
						handoff.id,
						handoff.alias,
						handoff.aliasToken ?? "",
						handoff.recovery,
						handoff.at,
						holder,
					);
		});
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
	}

	/**
	 * Keep questions whose asker or recipient is away until it is back. `senderReturnAddress`: the asker's own session,
	 * so a reply is not held for an asker that is already back under another Intercom id. #4950: a live asker's is kept
	 * too, resolved per question, so its failure still reaches it should this broker go before its departure.
	 */
	keep(
		questions: readonly PendingQuestion[],
		senderReturnAddress?: string | ((question: PendingQuestion) => string | undefined),
		/** #4997: the questions that may follow their peers to another broker. */
		movable: (question: PendingQuestion) => boolean = () => false,
	): void {
		if (questions.length === 0) return;
		const insert = this.statement(
			"INSERT OR REPLACE INTO away_questions (message_id, sender_session_id, target_session_id, sender_return_address, kept_at, movable) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const dropLive = this.statement(
			"DELETE FROM live_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
		);
		const at = this.now();
		// #4997: a live route becomes a kept one in one transaction, so a broker that stops at any point has it as one or
		// the other, never neither.
		this.batch(() => {
			for (const question of questions) {
				const returnAddress =
					typeof senderReturnAddress === "function" ? senderReturnAddress(question) : senderReturnAddress;
				insert.run(
					question.messageId,
					question.senderSessionId,
					question.targetSessionId,
					returnAddress ?? "",
					at,
					movable(question) ? 1 : 0,
				);
				dropLive.run(question.messageId, question.senderSessionId, question.targetSessionId);
			}
			this.purge();
		});
	}

	/**
	 * Keep questions whose recipient is away until it is back, up to {@link AWAY_ASKS_PER_RECIPIENT_MAX} for each
	 * recipient (#4996). Returns those refused: the caller fails each to its asker. One already kept is kept again.
	 */
	keepForAwayRecipient(
		questions: readonly PendingQuestion[],
		senderReturnAddress?: (question: PendingQuestion) => string | undefined,
		/** #4997: as `keep`'s. */
		movable?: (question: PendingQuestion) => boolean,
	): PendingQuestion[] {
		return this.batch(() => this.keepEachForAwayRecipient(questions, senderReturnAddress, movable));
	}

	private keepEachForAwayRecipient(
		questions: readonly PendingQuestion[],
		senderReturnAddress: ((question: PendingQuestion) => string | undefined) | undefined,
		movable: ((question: PendingQuestion) => boolean) | undefined,
	): PendingQuestion[] {
		const count = this.statement("SELECT COUNT(*) AS kept FROM away_questions WHERE target_session_id = ?");
		const already = this.statement(
			"SELECT 1 FROM away_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
		);
		const kept = new Map<string, number>();
		const admitted: PendingQuestion[] = [];
		const refused: PendingQuestion[] = [];
		for (const question of questions) {
			const target = question.targetSessionId;
			const waiting = kept.get(target) ?? Number(count.get(target)?.kept);
			if (already.get(question.messageId, question.senderSessionId, target) !== undefined) admitted.push(question);
			else if (waiting >= AWAY_ASKS_PER_RECIPIENT_MAX) refused.push(question);
			else {
				admitted.push(question);
				kept.set(target, waiting + 1);
			}
		}
		this.keep(admitted, senderReturnAddress, movable);
		// #4997: a refused question is failed to its asker; its live route goes in the same write as the kept ones.
		for (const question of refused) this.forgetLive(question);
		return refused;
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

	/** The kept question was answered some other way: it no longer waits here. Whether it was kept. */
	forget(question: PendingQuestion): boolean {
		const { changes } = this.statement(
			"DELETE FROM away_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
		).run(question.messageId, question.senderSessionId, question.targetSessionId);
		return Number(changes) > 0;
	}

	/** #4997: whether the question still waits here for an away peer. */
	isKept(question: PendingQuestion): boolean {
		return (
			this.statement(
				"SELECT 1 FROM away_questions WHERE message_id = ? AND sender_session_id = ? AND target_session_id = ?",
			).get(question.messageId, question.senderSessionId, question.targetSessionId) !== undefined
		);
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
		return this.batch(() => this.restoreEach(sessionId, returnAddress, isConnected));
	}

	private restoreEach(
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
	 * for its away asker. #4950: a question whose asker is connected is returned in `live` for the broker to fail on its
	 * route; one whose asker kept no return address and is not connected stays kept (it ages out), never dropped
	 * unseen. Returns the questions held for their askers.
	 */
	failForTarget(
		target: SessionInfo,
		reason: string,
		idPrefix: string,
		failedElsewhere: (question: PendingQuestion) => boolean,
		targetReturnAddress = "",
		askerConnected: (question: PendingQuestion, returnAddress: string) => boolean,
		skipMovable = false,
	): { failed: PendingQuestion[]; live: PendingQuestion[] } {
		return this.batch(() =>
			this.failEachForTarget(target, reason, idPrefix, failedElsewhere, targetReturnAddress, askerConnected, skipMovable),
		);
	}

	private failEachForTarget(
		target: SessionInfo,
		reason: string,
		idPrefix: string,
		failedElsewhere: (question: PendingQuestion) => boolean,
		targetReturnAddress: string,
		askerConnected: (question: PendingQuestion, returnAddress: string) => boolean,
		skipMovable: boolean,
	): { failed: PendingQuestion[]; live: PendingQuestion[] } {
		const rows = this.statement(
			`SELECT message_id, sender_session_id, sender_return_address FROM away_questions WHERE target_session_id = ? AND ${PROVEN_RECIPIENT} AND (? = 0 OR movable = 0) ORDER BY kept_at`,
		).all(target.id, targetReturnAddress, skipMovable ? 1 : 0);
		const failed: PendingQuestion[] = [];
		const live: PendingQuestion[] = [];
		for (const row of rows) {
			const question = {
				messageId: String(row.message_id),
				senderSessionId: String(row.sender_session_id),
				targetSessionId: target.id,
			};
			const returnAddress = typeof row.sender_return_address === "string" ? row.sender_return_address : "";
			if (askerConnected(question, returnAddress)) {
				live.push(question);
				this.forget(question);
				continue;
			}
			// An asker that kept no return address cannot be told while away: its question waits until it ages out.
			if (returnAddress === "") continue;
			// #4765: a released subagent's owner is handed this failure on its own route, which wakes the subagent.
			if (failedElsewhere(question)) {
				this.forget(question);
				continue;
			}
			failed.push(question);
			this.holdOne({ ...question, senderReturnAddress: returnAddress }, target, {
				// #4996: one id per ask (#5004), so a failure decided again after a crash is saved once by the asker.
				id: `${idPrefix}:${question.messageId}`,
				timestamp: this.now(),
				replyTo: question.messageId,
				replyError: reason,
				content: { text: reason },
			});
		}
		this.purge();
		return { failed, live };
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
				? this.statement(
						"SELECT child_name, target_session_id FROM parked_targets WHERE owner_session_id = ? ORDER BY parked_at, rowid",
					).all(ownerSessionId)
				: this.statement(
						"SELECT child_name, target_session_id FROM parked_targets WHERE owner_session_id = ? AND child_key = ? ORDER BY parked_at, rowid",
					).all(ownerSessionId, childName.trim().toLowerCase());
		const failed: Array<HeldAwayMessage & { readonly askerReturnAddress: string }> = [];
		// #4996: one transaction, however many asks end with the owner.
		this.batch(() => {
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
					// #4996: one id per ask, so a failure decided again after a crash is held once.
					id: `${idPrefix}:${question.messageId}`,
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
		});
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
		this.batch(() => {
			this.holdOne(question, from, message);
			this.purge();
		});
	}

	private holdOne(
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
