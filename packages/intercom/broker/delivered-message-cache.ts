import { createHmac, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DELIVERED_MESSAGE_TTL_MS } from "../retry-policy.js";

export const DELIVERED_MESSAGE_MAX_ENTRIES = 10_000;
/** Upper bound for persisted authority bytes (signatures are fixed-size HMAC digests). */
export const DELIVERED_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;
const AUTHORITY_KEY_BYTES = 32;
const AUTHORITY_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export type DeliveredMessageMatch = "miss" | "match" | "conflict" | "uncertain" | "invalid";
export type DeliveredMessageRecordResult = "recorded" | "match" | "conflict" | "uncertain" | "capacity" | "invalid";
export type DeliveredMessageAcceptResult = "accepted" | "conflict" | "invalid";

export interface DeliveredQuestionRoute {
	readonly targetSessionId: string;
	readonly senderGroupIdentity: string;
}

interface DeliveredMessage {
	state: "reserved" | "accepted";
	deliveredAt: number;
	signature: string;
	targetIdentity?: string;
	questionRoute?: DeliveredQuestionRoute;
}

interface SqliteStatement {
	get(...params: Array<string | number | null>): Record<string, unknown> | undefined;
	run(...params: Array<string | number | null>): { changes: number | bigint };
}

interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

function validStoredString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function entryByteSize(messageId: string, delivered: DeliveredMessage): number {
	return [
		messageId,
		delivered.signature,
		delivered.targetIdentity,
		delivered.questionRoute?.targetSessionId,
		delivered.questionRoute?.senderGroupIdentity,
	].reduce((total, value) => total + (value === undefined ? 0 : Buffer.byteLength(value)), 0);
}

function parseStoredMessage(row: Record<string, unknown> | undefined): DeliveredMessage | undefined | "invalid" {
	if (row === undefined) return undefined;
	if (
		(row.state !== "reserved" && row.state !== "accepted") ||
		!validStoredString(row.signature) ||
		!AUTHORITY_DIGEST_PATTERN.test(row.signature) ||
		typeof row.delivered_at !== "number" ||
		!Number.isSafeInteger(row.delivered_at) ||
		row.delivered_at < 0 ||
		(row.target_identity !== null && !validStoredString(row.target_identity))
	) {
		return "invalid";
	}
	const questionValues = [row.question_target_session_id, row.question_sender_group_identity];
	const hasQuestionRoute = questionValues.some((value) => value !== null);
	if (hasQuestionRoute && !questionValues.every(validStoredString)) return "invalid";
	return {
		state: row.state,
		deliveredAt: row.delivered_at,
		signature: row.signature,
		...(typeof row.target_identity === "string" ? { targetIdentity: row.target_identity } : {}),
		...(hasQuestionRoute
			? {
					questionRoute: {
						targetSessionId: row.question_target_session_id as string,
						senderGroupIdentity: row.question_sender_group_identity as string,
					},
				}
			: {}),
	};
}

/** Authority-key path derived without introducing another user setting. */
export function getDeliveredMessageAuthorityKeyPath(storagePath: string): string {
	return storagePath.endsWith(".sqlite") ? `${storagePath.slice(0, -".sqlite".length)}.key` : `${storagePath}.key`;
}

function restrictMode(path: string, mode: number): void {
	if (process.platform !== "win32") chmodSync(path, mode);
}

function restrictExistingAuthorityArtifacts(storagePath: string, keyPath: string): void {
	for (const path of [storagePath, `${storagePath}-wal`, `${storagePath}-shm`, keyPath]) {
		if (existsSync(path)) restrictMode(path, 0o600);
	}
}

/**
 * Prepare a paired database and key. A missing half of an existing pair is not
 * recreated: accepted authority may have been lost, so startup must fail closed.
 */
function prepareDurableAuthority(storagePath: string): Buffer | undefined {
	const directory = dirname(storagePath);
	const keyPath = getDeliveredMessageAuthorityKeyPath(storagePath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	restrictMode(directory, 0o700);
	restrictExistingAuthorityArtifacts(storagePath, keyPath);
	const databaseExists = existsSync(storagePath);
	const keyExists = existsSync(keyPath);
	if (databaseExists !== keyExists) return undefined;
	if (!databaseExists) {
		const key = randomBytes(AUTHORITY_KEY_BYTES);
		writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
		const databaseDescriptor = openSync(storagePath, "wx", 0o600);
		closeSync(databaseDescriptor);
		restrictExistingAuthorityArtifacts(storagePath, keyPath);
		return key;
	}
	const key = readFileSync(keyPath);
	if (key.length !== AUTHORITY_KEY_BYTES) return undefined;
	return key;
}

/**
 * Bounded durable operation authority. The broker uses a SQLite-backed instance;
 * tests may omit `storagePath` for an isolated in-memory authority. Durable
 * signatures are keyed SHA-256 HMACs, so message and attachment content never
 * reaches SQLite and low-entropy payloads cannot be tested without the paired
 * owner-only key file. A reservation is written before forwarding and promoted
 * to accepted after a confirmed write.
 */
export class DeliveredMessageCache {
	private readonly delivered = new Map<string, DeliveredMessage>();
	private retainedBytes = 0;
	private readonly database?: SqliteDatabase;
	private readonly authorityKey?: Buffer;
	private readonly storagePath?: string;
	private storageInvalid = false;

	constructor(
		private readonly ttlMs = DELIVERED_MESSAGE_TTL_MS,
		private readonly maxEntries = DELIVERED_MESSAGE_MAX_ENTRIES,
		storagePath?: string,
		private readonly maxBytes = DELIVERED_MESSAGE_MAX_BYTES,
	) {
		if (storagePath === undefined) return;
		this.storagePath = storagePath;
		let database: SqliteDatabase | undefined;
		try {
			const authorityKey = prepareDurableAuthority(storagePath);
			if (authorityKey === undefined) {
				this.storageInvalid = true;
				return;
			}
			this.authorityKey = authorityKey;
			database = new DatabaseSync(storagePath) as unknown as SqliteDatabase;
			database.exec("PRAGMA busy_timeout = 5000");
			database.exec("PRAGMA journal_mode = WAL");
			database.exec("PRAGMA synchronous = FULL");
			database.exec("PRAGMA trusted_schema = OFF");
			database.exec(`
				CREATE TABLE IF NOT EXISTS delivered_messages (
					state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted')),
					message_id TEXT PRIMARY KEY NOT NULL,
					signature TEXT NOT NULL,
					delivered_at INTEGER NOT NULL,
					target_identity TEXT,
					question_target_session_id TEXT,
					question_sender_group_identity TEXT
				) STRICT;
				CREATE INDEX IF NOT EXISTS delivered_messages_age
					ON delivered_messages(delivered_at);
			`);
			database.prepare("SELECT state, signature, delivered_at, target_identity FROM delivered_messages LIMIT 0").get();
			restrictExistingAuthorityArtifacts(storagePath, getDeliveredMessageAuthorityKeyPath(storagePath));
		} catch {
			database?.close();
			try {
				restrictExistingAuthorityArtifacts(storagePath, getDeliveredMessageAuthorityKeyPath(storagePath));
			} catch {
				// Storage is already invalid; permission correction is best-effort here.
			}
			this.storageInvalid = true;
			return;
		}
		this.database = database;
	}

	lookup(messageId: string, signature: string, now = Date.now()): DeliveredMessageMatch {
		const authority = this.signatureAuthority(signature);
		return authority === undefined ? "invalid" : this.lookupEntry(messageId, authority, undefined, false, now);
	}

	lookupForTarget(
		messageId: string,
		signature: string,
		targetIdentity: string,
		now = Date.now(),
	): DeliveredMessageMatch {
		const authority = this.signatureAuthority(signature);
		return authority === undefined ? "invalid" : this.lookupEntry(messageId, authority, targetIdentity, true, now);
	}

	lookupQuestionTarget(
		messageId: string,
		signature: string,
		senderGroupIdentity: string,
		now = Date.now(),
	): string | undefined {
		const authority = this.signatureAuthority(signature);
		if (authority === undefined) return undefined;
		this.prune(now);
		const delivered = this.read(messageId);
		if (
			delivered === undefined ||
			delivered === "invalid" ||
			delivered.state !== "accepted" ||
			now - delivered.deliveredAt > this.ttlMs ||
			delivered.signature !== authority ||
			delivered.questionRoute?.senderGroupIdentity !== senderGroupIdentity
		) {
			return undefined;
		}
		return delivered.questionRoute.targetSessionId;
	}

	record(
		messageId: string,
		signature: string,
		now = Date.now(),
		targetIdentity?: string,
	): DeliveredMessageRecordResult {
		return this.recordWithSignature(messageId, { state: "accepted", deliveredAt: now, signature, targetIdentity });
	}

	recordQuestion(
		messageId: string,
		signature: string,
		questionRoute: DeliveredQuestionRoute,
		now = Date.now(),
		targetIdentity?: string,
	): DeliveredMessageRecordResult {
		return this.recordWithSignature(messageId, {
			state: "accepted",
			deliveredAt: now,
			signature,
			targetIdentity,
			questionRoute,
		});
	}

	reserve(
		messageId: string,
		signature: string,
		now = Date.now(),
		targetIdentity?: string,
	): DeliveredMessageRecordResult {
		return this.recordWithSignature(messageId, { state: "reserved", deliveredAt: now, signature, targetIdentity });
	}

	reserveQuestion(
		messageId: string,
		signature: string,
		questionRoute: DeliveredQuestionRoute,
		now = Date.now(),
		targetIdentity?: string,
	): DeliveredMessageRecordResult {
		return this.recordWithSignature(messageId, {
			state: "reserved",
			deliveredAt: now,
			signature,
			targetIdentity,
			questionRoute,
		});
	}

	accept(messageId: string, signature: string, targetIdentity?: string): DeliveredMessageAcceptResult {
		const authority = this.signatureAuthority(signature);
		if (authority === undefined) return "invalid";
		const existing = this.read(messageId);
		if (existing === undefined || existing === "invalid") return "invalid";
		if (existing.signature !== authority || existing.targetIdentity !== targetIdentity) return "conflict";
		if (existing.state === "accepted") return "accepted";
		if (this.database === undefined) {
			existing.state = "accepted";
			return "accepted";
		}
		const updated = this.database
			.prepare("UPDATE delivered_messages SET state = 'accepted' WHERE message_id = ? AND signature = ?")
			.run(messageId, authority);
		this.restrictArtifacts();
		return Number(updated.changes) === 1 ? "accepted" : "invalid";
	}

	/** Remove only the exact pre-forward reservation after a proven write failure. */
	forget(messageId: string, signature: string): void {
		const authority = this.signatureAuthority(signature);
		if (authority === undefined) return;
		if (this.database === undefined) {
			const delivered = this.delivered.get(messageId);
			if (delivered?.signature === authority) {
				this.retainedBytes -= entryByteSize(messageId, delivered);
				this.delivered.delete(messageId);
			}
			return;
		}
		this.database
			.prepare("DELETE FROM delivered_messages WHERE message_id = ? AND signature = ?")
			.run(messageId, authority);
		this.restrictArtifacts();
	}

	close(): void {
		this.restrictArtifacts();
		this.database?.close();
		this.restrictArtifacts();
	}

	private signatureAuthority(signature: string): string | undefined {
		if (this.storageInvalid || !validStoredString(signature)) return undefined;
		if (this.storagePath === undefined) return signature;
		if (this.authorityKey === undefined) return undefined;
		return createHmac("sha256", this.authorityKey).update(signature).digest("hex");
	}

	private recordWithSignature(messageId: string, delivered: DeliveredMessage): DeliveredMessageRecordResult {
		const authority = this.signatureAuthority(delivered.signature);
		if (authority === undefined) return "invalid";
		return this.recordEntry(messageId, { ...delivered, signature: authority });
	}

	private lookupEntry(
		messageId: string,
		signature: string,
		targetIdentity: string | undefined,
		requireTargetIdentity: boolean,
		now: number,
	): DeliveredMessageMatch {
		if (this.storageInvalid) return "invalid";
		this.prune(now);
		const delivered = this.read(messageId);
		if (delivered === "invalid") return "invalid";
		if (delivered === undefined || now - delivered.deliveredAt > this.ttlMs) return "miss";
		if (delivered.signature !== signature) return "conflict";
		if (requireTargetIdentity && delivered.targetIdentity !== targetIdentity) return "conflict";
		if (delivered.state === "reserved") return "uncertain";
		return "match";
	}

	private recordEntry(messageId: string, delivered: DeliveredMessage): DeliveredMessageRecordResult {
		if (this.storageInvalid) return "invalid";
		if (!validStoredString(messageId) || !validStoredString(delivered.signature)) return "invalid";
		if (
			!Number.isSafeInteger(delivered.deliveredAt) ||
			delivered.deliveredAt < 0 ||
			(delivered.targetIdentity !== undefined && !validStoredString(delivered.targetIdentity)) ||
			(delivered.questionRoute !== undefined &&
				(!validStoredString(delivered.questionRoute.targetSessionId) ||
					!validStoredString(delivered.questionRoute.senderGroupIdentity)))
		) {
			return "invalid";
		}
		if (entryByteSize(messageId, delivered) > this.maxBytes) return "capacity";
		if (this.database === undefined) return this.recordMemory(messageId, delivered);
		return this.recordDurable(messageId, delivered);
	}

	private recordMemory(messageId: string, delivered: DeliveredMessage): DeliveredMessageRecordResult {
		this.pruneMemory(delivered.deliveredAt);
		const existing = this.delivered.get(messageId);
		if (existing !== undefined) return this.compare(existing, delivered);
		const size = entryByteSize(messageId, delivered);
		if (this.delivered.size >= this.maxEntries || this.retainedBytes + size > this.maxBytes) return "capacity";
		this.delivered.set(messageId, delivered);
		this.retainedBytes += size;
		return "recorded";
	}

	private recordDurable(messageId: string, delivered: DeliveredMessage): DeliveredMessageRecordResult {
		const database = this.database;
		if (database === undefined) return "invalid";
		database.exec("BEGIN IMMEDIATE");
		try {
			this.pruneDurable(delivered.deliveredAt);
			const existing = this.readDurable(messageId);
			if (existing !== undefined) {
				database.exec("COMMIT");
				return existing === "invalid" ? "invalid" : this.compare(existing, delivered);
			}
			const totals = database.prepare(`
				SELECT COUNT(*) AS count,
					COALESCE(SUM(
						length(CAST(message_id AS BLOB)) + length(CAST(signature AS BLOB)) +
						COALESCE(length(CAST(target_identity AS BLOB)), 0) +
						COALESCE(length(CAST(question_target_session_id AS BLOB)), 0) +
						COALESCE(length(CAST(question_sender_group_identity AS BLOB)), 0)
					), 0) AS bytes
				FROM delivered_messages
			`).get();
			const count = totals?.count;
			const bytes = totals?.bytes;
			if (
				typeof count !== "number" ||
				!Number.isSafeInteger(count) ||
				count < 0 ||
				typeof bytes !== "number" ||
				!Number.isSafeInteger(bytes) ||
				bytes < 0
			) {
				database.exec("COMMIT");
				return "invalid";
			}
			if (count >= this.maxEntries || bytes + entryByteSize(messageId, delivered) > this.maxBytes) {
				database.exec("COMMIT");
				return "capacity";
			}
			database
				.prepare(`
					INSERT INTO delivered_messages (
						message_id, state, signature, delivered_at, target_identity,
						question_target_session_id, question_sender_group_identity
					) VALUES (?, ?, ?, ?, ?, ?, ?)
				`)
				.run(
					messageId,
					delivered.state,
					delivered.signature,
					delivered.deliveredAt,
					delivered.targetIdentity ?? null,
					delivered.questionRoute?.targetSessionId ?? null,
					delivered.questionRoute?.senderGroupIdentity ?? null,
				);
			database.exec("COMMIT");
			this.restrictArtifacts();
			return "recorded";
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the original storage failure.
			}
			throw error;
		}
	}

	private compare(existing: DeliveredMessage, incoming: DeliveredMessage): DeliveredMessageRecordResult {
		if (existing.signature !== incoming.signature || existing.targetIdentity !== incoming.targetIdentity) {
			return "conflict";
		}
		return existing.state === "accepted" ? "match" : "uncertain";
	}

	private read(messageId: string): DeliveredMessage | undefined | "invalid" {
		return this.database === undefined ? this.delivered.get(messageId) : this.readDurable(messageId);
	}

	private readDurable(messageId: string): DeliveredMessage | undefined | "invalid" {
		const row = this.database
			?.prepare(`
				SELECT state, signature, delivered_at, target_identity,
					question_target_session_id, question_sender_group_identity
				FROM delivered_messages WHERE message_id = ?
			`)
			.get(messageId);
		return parseStoredMessage(row);
	}

	private prune(now: number): void {
		if (this.database === undefined) this.pruneMemory(now);
		else this.pruneDurable(now);
	}

	private pruneMemory(now: number): void {
		for (const [messageId, delivered] of this.delivered) {
			if (now - delivered.deliveredAt <= this.ttlMs) continue;
			this.delivered.delete(messageId);
			this.retainedBytes -= entryByteSize(messageId, delivered);
		}
	}

	private pruneDurable(now: number): void {
		this.database
			?.prepare("DELETE FROM delivered_messages WHERE typeof(delivered_at) = 'integer' AND ? - delivered_at > ?")
			.run(now, this.ttlMs);
		this.restrictArtifacts();
	}

	private restrictArtifacts(): void {
		if (this.storagePath === undefined || this.storageInvalid) return;
		restrictExistingAuthorityArtifacts(this.storagePath, getDeliveredMessageAuthorityKeyPath(this.storagePath));
	}
}
