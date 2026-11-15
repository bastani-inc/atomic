import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { computeEditsDiff, type Edit } from "../src/core/tools/edit-diff.js";
import { isEditInputError, isEditMatchError, isEditTargetError } from "../src/core/tools/file-tool-errors.js";
import { createEditTool } from "../src/index.js";

const editTool = createEditTool(process.cwd());

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "edit-exactness-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function writeTestFile(name: string, content: string | Buffer): string {
	const path = join(testDir, name);
	writeFileSync(path, content);
	return path;
}

async function edit(path: string, edits: Edit[]): Promise<void> {
	await editTool.execute("exactness", { path, edits });
}

describe("edit tool exactness (#4893)", () => {
	it("refuses an oldText that matches twice with overlapping occurrences (#4893)", async () => {
		const path = writeTestFile("braces.txt", "}\n}\n}\n");

		await assert.rejects(edit(path, [{ oldText: "}\n}", newText: "X" }]), (error: Error) => {
			assert.ok(isEditMatchError(error));
			assert.equal(error.code, "text-not-unique");
			assert.equal(error.fields.occurrences, 2);
			return true;
		});
		assert.equal(readFileSync(path, "utf-8"), "}\n}\n}\n");
	});

	it("refuses a file that is not valid UTF-8 and leaves its bytes unchanged (#4893)", async () => {
		const original = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x66, 0x6f, 0x6f, 0x0a]); // "caf\xE9\nfoo\n" in Latin-1
		const path = writeTestFile("latin1.txt", original);

		await assert.rejects(edit(path, [{ oldText: "foo", newText: "bar" }]), (error: Error) => {
			assert.ok(isEditTargetError(error));
			assert.equal(error.code, "target-not-utf8");
			assert.equal(error.fields.path, path);
			assert.equal(error.hint, "Edit the file with a tool that keeps its encoding, or convert it to UTF-8 first.");
			assert.ok(error.cause instanceof TypeError);
			assert.match(error.message, /latin1\.txt/);
			assert.match(error.message, /UTF-8/);
			return true;
		});
		assert.ok(readFileSync(path).equals(original));
		const preview = await computeEditsDiff(path, [{ oldText: "foo", newText: "bar" }], testDir);
		assert.ok("error" in preview);
		assert.match(preview.error, /UTF-8/);
	});

	it("keeps the BOM and CRLF line endings byte for byte around an edit (#4893)", async () => {
		const path = writeTestFile("bom-crlf.txt", "\uFEFFone \r\ntwo\r\nthree\r\n");

		await edit(path, [{ oldText: "two", newText: "2" }]);

		assert.ok(readFileSync(path).equals(Buffer.from("\uFEFFone \r\n2\r\nthree\r\n")));
	});

	it("keeps compatibility characters outside a fuzzy match unnormalised (#4893)", async () => {
		const path = writeTestFile("superscript.txt", "x\u00B2 = y   \nlabel = '\u2460'  \n");

		// The trailing whitespace in the file forces fuzzy matching; x² and ① sit outside oldText.
		await edit(path, [{ oldText: "= y\nlabel =", newText: "= z\nname =" }]);

		assert.equal(readFileSync(path, "utf-8"), "x\u00B2 = z\nname = '\u2460'  \n");
	});

	it("keeps trailing whitespace after a fuzzy match on the same line (#4893)", async () => {
		const path = writeTestFile("quotes.txt", "say(\u201Chi\u201D)  \nkeep  \n");

		await edit(path, [{ oldText: 'say("hi")', newText: 'say("bye")' }]);

		assert.equal(readFileSync(path, "utf-8"), 'say("bye")  \nkeep  \n');
	});

	it("replaces only the matched part of plain ASCII lines in a fuzzy match (#4893)", async () => {
		const path = writeTestFile("ascii.txt", "const a = 1;   \nnext line\n");

		await edit(path, [{ oldText: "a = 1;\nnext", newText: "b = 2;\nNEXT" }]);

		assert.equal(readFileSync(path, "utf-8"), "const b = 2;\nNEXT line\n");
	});

	it("strips trailing whitespace that shares a grapheme cluster with the last character (#4893)", async () => {
		// U+0600 is a prepended concatenation mark: it and the space after it form one grapheme cluster.
		const path = writeTestFile("prepend.txt", "a\u0600   \nb\n");

		await edit(path, [{ oldText: "a\u0600\nb", newText: "c" }]);

		assert.equal(readFileSync(path, "utf-8"), "c\n");
	});

	it("uses an exact unique match even when fuzzy matching would find two (#4893)", async () => {
		const path = writeTestFile("exact.txt", "a  \nb\na\nb\n");

		await edit(path, [{ oldText: "a\nb\n", newText: "c\n" }]);

		assert.equal(readFileSync(path, "utf-8"), "a  \nb\nc\n");
	});

	it("refuses a fuzzy match that starts or ends inside one original character (#4893)", async () => {
		// U+FB00 normalises to "ff"; replacing only one of its f's would rewrite the other.
		const path = writeTestFile("ligature.txt", "say \uFB00 tail  \n");

		for (const oldText of ["f tail", "say f"]) {
			await assert.rejects(edit(path, [{ oldText, newText: "x" }]), (error: Error) => {
				assert.ok(isEditMatchError(error));
				assert.equal(error.code, "text-not-found");
				return true;
			});
		}
		assert.equal(readFileSync(path, "utf-8"), "say \uFB00 tail  \n");
	});

	it("reports a whitespace-only oldText that only matches after normalisation as not found (#4893)", async () => {
		const path = writeTestFile("blank.txt", "a\t\nb\n");

		await assert.rejects(edit(path, [{ oldText: "  ", newText: "x" }]), (error: Error) => {
			assert.ok(isEditMatchError(error));
			assert.equal(error.code, "text-not-found");
			return true;
		});
	});
});

describe("edit tool surrogate pairs (#5013)", () => {
	const original = "x\u{1F600}y\n";

	async function assertSplitRefused(edits: Edit[], editIndex: number): Promise<void> {
		const path = writeTestFile("emoji.txt", original);
		await assert.rejects(edit(path, edits), (error: Error) => {
			assert.ok(isEditInputError(error));
			assert.equal(error.code, "text-splits-character");
			assert.deepEqual(error.fields, { path, editIndex, totalEdits: edits.length });
			const named = edits.length === 1 ? "oldText or newText" : `edits[${editIndex}].oldText or newText`;
			assert.ok(error.message.startsWith(`${named} contains half of a surrogate pair in ${path}.`));
			assert.match(error.hint, /both halves of every emoji/);
			return true;
		});
		assert.ok(readFileSync(path).equals(Buffer.from(original)));
	}

	it("refuses an oldText ending in a lone high surrogate, a match that ends inside a pair (#5013)", async () => {
		await assertSplitRefused([{ oldText: "x\uD83D", newText: "z" }], 0);
	});

	it("refuses an oldText starting with a lone low surrogate, a match that starts inside a pair (#5013)", async () => {
		await assertSplitRefused([{ oldText: "\uDE00y", newText: "z" }], 0);
	});

	it("refuses a newText with a leading or trailing lone surrogate (#5013)", async () => {
		await assertSplitRefused([{ oldText: "y", newText: "\uDE00z" }], 0);
		await assertSplitRefused([{ oldText: "y", newText: "z\uD83D" }], 0);
	});

	it("names the edit with the lone surrogate among several (#5013)", async () => {
		await assertSplitRefused(
			[
				{ oldText: "x", newText: "w" },
				{ oldText: "y", newText: "\uD83D" },
			],
			1,
		);
	});

	it("still edits text containing whole emoji (#5013)", async () => {
		const path = writeTestFile("emoji.txt", original);

		await edit(path, [{ oldText: "\u{1F600}y", newText: "\u{1F389}z" }]);

		assert.equal(readFileSync(path, "utf-8"), "x\u{1F389}z\n");
	});
});

/** Linear congruential generator returning integers in [0, n); seeded so a failure reproduces. */
function seededRandom(seed: number): (n: number) => number {
	let state = seed;
	return (n) => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return Math.floor((state / 0x80000000) * n);
	};
}

/** Every start offset of `needle` in `haystack`, overlapping occurrences included. */
function exactOccurrences(haystack: string, needle: string): number[] {
	const offsets: number[] = [];
	for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
		offsets.push(index);
	}
	return offsets;
}

/**
 * Whether `result` is `original` with one range replaced by `inserted`: some prefix and suffix of `original`
 * surround `inserted` in `result` without overlapping each other.
 */
function isSingleSplice(original: string, result: string, inserted: string): boolean {
	for (let start = 0; start + inserted.length <= result.length; start++) {
		const suffixLength = result.length - start - inserted.length;
		if (start + suffixLength > original.length) continue;
		if (
			result.startsWith(original.slice(0, start)) &&
			result.slice(start, start + inserted.length) === inserted &&
			original.endsWith(result.slice(start + inserted.length))
		) {
			return true;
		}
	}
	return false;
}

describe("edit tool exactness properties (#4893)", () => {
	// Characters that exercise every fuzzy normalisation: trailing whitespace, smart quotes, dashes, special
	// spaces, NFKC compatibility forms and a combining mark, alongside repetitive ASCII that produces overlaps.
	const alphabet = ["a", "a", "b", "}", " ", " ", "\t", "\n", "\n", "\r\n", "\u201C", '"', "\u2013", "-"];
	const exotic = ["\u00B2", "\u2460", "\uFB00", "\u00A0", "e\u0301", "\u00E9", "\uFF21", "\u3000"];

	function randomFile(random: (n: number) => number): string {
		let text = "";
		for (let length = random(40) + 1; length > 0; length--) {
			text += random(6) === 0 ? exotic[random(exotic.length)] : alphabet[random(alphabet.length)];
		}
		return text;
	}

	it("never changes text outside the matched range for random files and edits (#4893)", async () => {
		const random = seededRandom(4893);
		let applied = 0;
		for (let run = 0; run < 400; run++) {
			const original = randomFile(random);
			const lf = original.replaceAll("\r\n", "\n");
			const start = random(lf.length);
			let oldText = lf.slice(start, start + 1 + random(8));
			// Perturb some edits so they only match after fuzzy normalisation.
			if (random(3) === 0)
				oldText = oldText.replaceAll("\u201C", '"').replaceAll("\u2013", "-").replaceAll("  ", " ");
			const newText = ["", "X", "Y\u00B2", "}"][random(4)];
			const path = writeTestFile(`random-${run}.txt`, original);
			try {
				await edit(path, [{ oldText, newText }]);
			} catch (error) {
				if (isEditMatchError(error)) {
					assert.equal(readFileSync(path, "utf-8"), original, `failed edit changed the file in run ${run}`);
					continue;
				}
				throw error;
			}
			const result = readFileSync(path, "utf-8");
			assert.ok(
				isSingleSplice(original, result, newText),
				`run ${run}: ${JSON.stringify({ original, oldText, newText, result })}`,
			);
			applied++;
		}
		assert.ok(applied > 100, `only ${applied} edits applied`);
	});

	it("refuses every edit whose oldText matches exactly at two or more offsets (#4893)", async () => {
		const random = seededRandom(4894);
		let refused = 0;
		let overlappingRefused = 0;
		for (let run = 0; run < 400; run++) {
			let original = randomFile(random).replaceAll("\r\n", "\n");
			let oldText: string;
			if (run % 2 === 0) {
				const start = random(original.length);
				oldText = original.slice(start, start + 1 + random(4));
			} else {
				// A period repeated three times holds two overlapping copies of the period repeated twice.
				const period = randomFile(random)
					.replaceAll("\r\n", "\n")
					.slice(0, 1 + random(3));
				const at = random(original.length + 1);
				original = `${original.slice(0, at)}${period.repeat(3)}${original.slice(at)}`;
				oldText = period.repeat(2);
			}
			const occurrences = exactOccurrences(original, oldText);
			const path = writeTestFile(`unique-${run}.txt`, original);
			if (occurrences.length < 2) {
				// Exactly one exact match: the edit replaces it, whatever fuzzy matching would count.
				await edit(path, [{ oldText, newText: `${oldText}#` }]);
				const index = occurrences[0];
				assert.equal(
					readFileSync(path, "utf-8"),
					`${original.slice(0, index)}${oldText}#${original.slice(index + oldText.length)}`,
				);
				continue;
			}
			await assert.rejects(edit(path, [{ oldText, newText: "#" }]), (error: Error) => {
				assert.ok(isEditMatchError(error));
				assert.equal(error.code, "text-not-unique");
				assert.equal(error.fields.occurrences, occurrences.length);
				return true;
			});
			assert.equal(readFileSync(path, "utf-8"), original);
			refused++;
			if (occurrences.some((offset, i) => i > 0 && offset < occurrences[i - 1] + oldText.length)) {
				overlappingRefused++;
			}
		}
		assert.ok(refused > 50, `only ${refused} duplicate edits generated`);
		assert.ok(overlappingRefused > 10, `only ${overlappingRefused} overlapping duplicate edits generated`);
	});
});
