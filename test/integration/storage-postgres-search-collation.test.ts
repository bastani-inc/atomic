import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import {
	openPostgresAdmin,
	postgresSkipReason,
	postgresTestPassword,
	postgresUrlFor,
} from "../helpers/postgres-database.js";

const FORMAT = 1;
const TEXTS = ["INFO ISTANBUL started", "nothing here", "ΒΑΣΑ ΚΑΙ ΣΚΙΑ", "Stra\u00dfe \u212Aelvin \u017fong"];

const DATABASE_LOCALES = {
	"the default locale": "",
	"an ICU Turkish locale": "LOCALE_PROVIDER icu ICU_LOCALE 'tr-TR' LOCALE 'C'",
	"an ICU root locale": "LOCALE_PROVIDER icu ICU_LOCALE 'und' LOCALE 'C'",
} as const;

function message(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-16T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL session search index under database locales", () => {
	for (const [label, locale] of Object.entries(DATABASE_LOCALES)) {
		it(`finds entries whatever their letter case in a database with ${label} (#5250)`, async () => {
			const admin = await openPostgresAdmin();
			const name = `atomic_collation_${randomBytes(6).toString("hex")}`;
			await admin.exec(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' ${locale}`);
			try {
				const database = await openPostgresDatabase({
					url: postgresUrlFor(name),
					...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
				});
				try {
					const store = await SqlSessionStore.open(database, { prefix: "loc_" });
					const index = store.searchIndex;
					assert.ok(index, "the store keeps a search index");
					await store.create(
						{ id: "s", version: SESSION_FORMAT_VERSION, createdAt: "2026-11-16T00:00:00.000Z", cwd: "/p" },
						TEXTS.map((text, position) => message(`e${position + 1}`, text)),
					);
					const texts = TEXTS.map((text, position) => ({ seq: position + 1, text }));
					assert.equal(await index.extend("s", FORMAT, 0, TEXTS.length, texts), true);
					const found = async (literals: readonly string[]) =>
						index.candidates("s", [literals], 1, TEXTS.length, 10);
					assert.deepEqual(await found(["istanbul"]), [1], "lower-case ASCII finds capitals");
					assert.deepEqual(await found(["info", "started"]), [1]);
					assert.deepEqual(await found(["ISTANBUL"]), [1], "capitals find themselves");
					assert.deepEqual(await found(["ΒΑΣ"]), [3], "a capital sigma before a letter");
					assert.deepEqual(await found(["ΚΑΙ"]), [3]);
					assert.deepEqual(await found(["σκια"]), [3], "lower-case Greek finds capitals");
					assert.deepEqual(await found(["Straße"]), [4]);
					assert.deepEqual(await found(["kelvin", "song"]), [4], "letters that fold to ASCII");
					assert.deepEqual(await found(["nothing"]), [2]);
					await store.close();
				} finally {
					await database.close();
				}
			} finally {
				await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
				await admin.close();
			}
		});
	}
});
