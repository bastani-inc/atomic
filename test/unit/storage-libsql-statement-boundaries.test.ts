import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { countRows, type FakeLibsqlFault, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";

/**
 * Which texts of one `exec` the libSQL adapter sends again after the server answered them busy or schema-changed: one
 * statement may run again, as the server ran nothing of it; several statements are never sent again whole, as the
 * ones before the statement the server refused may have committed, though the refused statement may run again on its
 * own (#5652). The texts are generated, and SQLite itself tells how many statements each holds.
 */

const { server, open } = useFakeLibsqlServers();

/** The two answers after which a server ran nothing of a statement, and the adapter may send one statement again. */
const FAULTS: readonly FakeLibsqlFault[] = [{ kind: "busy" }, { kind: "schema-changed" }];

/** The seed of the generated texts, so a text that fails is generated again by the same run. */
const SEED = 5509;
/** Generated texts of several statements, and of one trigger: each is one request, or two, to a local fake server. */
const SEVERAL_STATEMENT_TEXTS = 400;
const ONE_TRIGGER_TEXTS = 150;

/**
 * Names that SQLite reads as one name although they begin with the letters of a keyword: any character outside ASCII,
 * a combining accent, a joiner, a no-break space or an emoji included, belongs to the name.
 */
const UNICODE_NAMES = [
	"case\u0301",
	"ca\u017Fe",
	"case\u00A0",
	"case\u200D",
	"case\u2028",
	"case\u{1F600}",
	"end\u0301",
	"\u00E9nd",
	"begin\u0300",
	"trigger\u0308",
	"plain",
];
/** Names written quoted, which are keywords when not quoted. */
const QUOTED_NAMES = ['"case"', "[end]", "`begin`"];
/** Every column of the table the texts write and the triggers watch. */
const COLUMNS = ["case", "end", "begin", ...UNICODE_NAMES];
const TABLE = `CREATE TABLE events(n INTEGER NOT NULL DEFAULT 0, ${COLUMNS.map((name) => `"${name}" TEXT`).join(", ")})`;

/** Text SQLite skips between tokens: whitespace and comments, with `;`, `END` and `CASE` inside the comments. */
const GAPS = [" ", "\n", "\t", "\r\n", "\f", "  /* ; END; CASE */ ", " -- ; END; CASE\n", "/**/", " /* END */\n"];
/** A byte-order mark, which SQLite skips like whitespace where a token starts. */
const BYTE_ORDER_MARK = " \uFEFF ";

/** A seeded random source (mulberry32). */
function randomSource(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function sqlTexts(seed: number, byteOrderMarks: boolean) {
	const random = randomSource(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
	const gap = () => (byteOrderMarks && random() < 0.1 ? BYTE_ORDER_MARK : random() < 0.6 ? " " : pick(GAPS));
	const keyword = (word: string) => pick([word, word.toLowerCase(), word[0] + word.slice(1).toLowerCase()]);
	const expression = (): string =>
		pick([
			() => `new.${pick(UNICODE_NAMES)}`,
			() => `new.${pick(QUOTED_NAMES)}`,
			() => pick(["'; END;'", "'CASE'", "'it''s; END'", "'/* not a comment'", "'-- nor this'", "x'00ff'", "1.5e3"]),
			() =>
				`${keyword("CASE")}${gap()}${keyword("WHEN")} new.n > 0 ${keyword("THEN")} ${expression()} ${keyword("ELSE")} ${expression()}${gap()}${keyword("END")}`,
			() => `(${expression()}${gap()}||${gap()}${expression()})`,
		])();
	const body = () =>
		Array.from(
			{ length: 1 + Math.floor(random() * 3) },
			() => `${keyword("SELECT")}${gap()}${expression()}${gap()};${gap()}`,
		).join("");
	const trigger = (name: string) =>
		[
			keyword("CREATE"),
			...(random() < 0.2 ? [keyword(pick(["TEMP", "TEMPORARY"]))] : []),
			keyword("TRIGGER"),
			name,
			`${keyword("AFTER")} ${keyword("INSERT")} ${keyword("ON")} events`,
			...(random() < 0.3 ? [`${keyword("WHEN")} ${expression()} IS NOT NULL`] : []),
			keyword("BEGIN"),
			`${body()}${keyword("END")}`,
		].join(gap());
	const write = () =>
		`${pick(["UPDATE events SET n = n + 1", "UPDATE events SET n = n + 1 WHERE 'END' <> ';'"])}${gap()};${gap()}`;
	return {
		/** A trigger, then writes, then mostly another trigger whose own `END` closes the text. */
		several(index: number) {
			const writes = 1 + Math.floor(random() * 3);
			const first = `${trigger(`t${index}_first`)}${gap()};${gap()}${Array.from({ length: writes }, write).join("")}`;
			if (random() < 0.2) return { sql: first + write(), writes: writes + 1 };
			return { sql: `${first}${trigger(`t${index}_last`)}${random() < 0.5 ? ";" : ""}`, writes };
		},
		/** One trigger, followed by nothing but `;`, whitespace and comments. */
		one(index: number) {
			const name = `t${index}_only`;
			return { sql: `${trigger(name)}${random() < 0.6 ? `${gap()};${gap()}` : ""}`, name };
		},
	};
}

/** The writes SQLite itself runs for `sql`: as many as the text holds statements of its own that write. */
function writesSqliteRuns(sql: string): number {
	const database = new DatabaseSync(":memory:");
	try {
		database.exec(TABLE);
		database.exec("INSERT INTO events (n) VALUES (0)");
		database.exec(sql);
		return Number((database.prepare("SELECT n FROM events").get() as { n: number | bigint }).n);
	} finally {
		database.close();
	}
}

test("no statement of a generated text of several statements, with names outside ASCII, comments and literals, runs twice, and no such text is sent again whole, after the server answered it busy or schema-changed (#5509, #5652)", async () => {
	// One server answers every text at once, the other refuses its first statement busy or schema-changed.
	const plain = await server();
	const fake = await server();
	const plainDatabase = await open(plain.url);
	const database = await open(fake.url);
	for (const each of [plainDatabase, database]) {
		await each.exec(TABLE);
		await each.run("INSERT INTO events (n) VALUES (0)");
	}
	const count = (on: typeof fake) => countRows(on, "SELECT n AS count FROM events");
	const texts = sqlTexts(SEED, true);
	const wrong: string[] = [];
	let landed = 0;
	for (let index = 0; index < SEVERAL_STATEMENT_TEXTS; index++) {
		const { sql, writes } = texts.several(index);
		assert.equal(writesSqliteRuns(sql), writes, `SQLite runs ${JSON.stringify(sql)} as several statements`);
		// Without a refusal every statement runs once, as SQLite runs the text.
		const plainBefore = count(plain);
		const plainRan = await plainDatabase.exec(sql).then(
			() => true,
			() => false,
		);
		if (!plainRan || count(plain) - plainBefore !== writes) wrong.push(`without a refusal: ${JSON.stringify(sql)}`);
		// After a refusal the text either fails having run nothing, sent once, or runs each statement once, never sent
		// again whole.
		const before = count(fake);
		fake.fail(FAULTS[index % FAULTS.length]!);
		const ran = await database.exec(sql).then(
			() => true,
			() => false,
		);
		const added = count(fake) - before;
		const whole = fake.pipelines.filter((pipeline) => pipeline.sql.includes(sql)).length;
		if (ran ? added !== writes || whole !== 0 : added !== 0 || whole !== 1)
			wrong.push(
				`after a refusal (ran ${ran}, wrote ${added} of ${writes}, sent whole ${whole}): ${JSON.stringify(sql)}`,
			);
		if (ran) landed += writes;
	}
	assert.deepEqual(
		wrong.slice(0, 3),
		[],
		`${wrong.length} of ${SEVERAL_STATEMENT_TEXTS} texts of several statements ran a statement twice, or not as SQLite does`,
	);
	assert.equal(count(fake), landed);
});

test("a generated trigger alone in one exec, with names outside ASCII, comments and literals, lands once after the server answered it busy or schema-changed (#5509)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec(TABLE);
	const texts = sqlTexts(SEED, false);
	const notLanded: string[] = [];
	for (let index = 0; index < ONE_TRIGGER_TEXTS; index++) {
		const { sql, name } = texts.one(index);
		assert.equal(writesSqliteRuns(sql), 0, `SQLite runs ${JSON.stringify(sql)}`);
		fake.fail(FAULTS[index % FAULTS.length]!);
		await database.exec(sql).catch(() => undefined);
		const landed = countRows(
			fake,
			`SELECT COUNT(*) AS count FROM (SELECT name FROM sqlite_schema UNION ALL SELECT name FROM sqlite_temp_schema) WHERE name = '${name}'`,
		);
		if (landed !== 1) notLanded.push(JSON.stringify(sql));
	}
	assert.deepEqual(notLanded.slice(0, 3), [], `${notLanded.length} of ${ONE_TRIGGER_TEXTS} triggers did not land`);
});
