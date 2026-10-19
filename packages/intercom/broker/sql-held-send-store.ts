import { type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import type {
	HeldSend,
	HeldSendDropResult,
	HeldSendHoldResult,
	HeldSendListResult,
	HeldSendRequest,
	HeldSendStore,
	HeldSendTakeResult,
	IntercomBrokerStateOptions,
	InvalidStateInput,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";

type HeldRow = SqliteRow & {
	reservation_key: string;
	origin_broker_id: string;
	sender_session_id: string;
	request_json: string;
};

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

const invalid = (reason: StateStoreInvalidReason): InvalidStateInput => ({ status: "invalid", reason });

function heldSendOf(row: HeldRow): HeldSend {
	return {
		reservationKey: row.reservation_key,
		originBrokerId: row.origin_broker_id,
		senderSessionId: row.sender_session_id,
		request: JSON.parse(row.request_json) as HeldSendRequest,
	};
}

/**
 * S3: `HeldSendStore` on the shared storage adapter's database, table `<prefix>intercom_held_sends`. Sends are keyed
 * by `reservationKeyFor(capability)`; the capability itself is never stored.
 */
export async function openSqlHeldSendStore({ database, prefix }: IntercomBrokerStateOptions): Promise<HeldSendStore> {
	const table = `${validateStoragePrefix(prefix)}intercom_held_sends`;
	await database.transaction((tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				"order" INTEGER PRIMARY KEY AUTOINCREMENT,
				message_id TEXT NOT NULL UNIQUE,
				reservation_key TEXT NOT NULL,
				origin_broker_id TEXT NOT NULL,
				sender_session_id TEXT NOT NULL,
				request_json TEXT NOT NULL,
				held_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ${table}_reservation ON ${table}(reservation_key, "order");
		`),
	);
	const selectForReservation = `SELECT reservation_key, origin_broker_id, sender_session_id, request_json FROM ${table}
		WHERE reservation_key = ? ORDER BY "order"`;

	return {
		async hold(send): Promise<HeldSendHoldResult> {
			if (send.reservationKey.length === 0) return invalid("empty-reservation-key");
			if (send.originBrokerId.length === 0) return invalid("empty-broker-id");
			if (send.senderSessionId.length === 0) return invalid("empty-session-id");
			const messageId = send.request.message.id;
			if (messageId.length === 0) return invalid("empty-message-id");
			const { changes } = await database.run(
				`INSERT INTO ${table}(message_id, reservation_key, origin_broker_id, sender_session_id, request_json, held_at)
				 VALUES (?, ?, ?, ?, ?, ${STORE_NOW}) ON CONFLICT(message_id) DO NOTHING`,
				messageId,
				send.reservationKey,
				send.originBrokerId,
				send.senderSessionId,
				JSON.stringify(send.request),
			);
			return changes === 0 ? { status: "duplicate" } : { status: "held" };
		},
		async list(reservationKey): Promise<HeldSendListResult> {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			const rows = await database.all<HeldRow>(selectForReservation, reservationKey);
			return { status: "listed", sends: rows.map(heldSendOf) };
		},
		async take(reservationKey): Promise<HeldSendTakeResult> {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			const rows = await database.transaction(async (tx) => {
				const taken = await tx.all<HeldRow>(selectForReservation, reservationKey);
				await tx.run(`DELETE FROM ${table} WHERE reservation_key = ?`, reservationKey);
				return taken;
			});
			return { status: "taken", sends: rows.map(heldSendOf) };
		},
		async drop(messageId): Promise<HeldSendDropResult> {
			if (messageId.length === 0) return invalid("empty-message-id");
			const { changes } = await database.run(`DELETE FROM ${table} WHERE message_id = ?`, messageId);
			return changes === 0 ? { status: "missing" } : { status: "dropped" };
		},
	};
}
