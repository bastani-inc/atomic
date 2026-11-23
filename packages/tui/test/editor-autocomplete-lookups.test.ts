import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AutocompleteProvider, AutocompleteSuggestions } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

type Lookup = (
	text: string,
	options: { signal: AbortSignal; force?: boolean },
) => ReturnType<AutocompleteProvider["getSuggestions"]>;

const keep = { preserveSelection: true, refreshMenu: true } as const;

function answer(prefix: string, ...values: string[]): AutocompleteSuggestions {
	return { prefix, items: values.map((value) => ({ value, label: value })) };
}

/** Replaces the typed prefix with the row's value. */
function applyCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: { value: string },
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] ?? "";
	const next = [...lines];
	next[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
	return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
}

function provider(lookup: Lookup): AutocompleteProvider {
	return {
		getSuggestions: (lines, cursorLine, cursorCol, options) =>
			lookup((lines[cursorLine] ?? "").slice(0, cursorCol), options),
		applyCompletion,
	};
}

function createEditor(): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

function rows(editor: Editor): string[] {
	return editor.render(80).map((line) => stripVTControlCharacters(line).trim());
}

function type(editor: Editor, text: string): void {
	for (const ch of text) editor.handleInput(ch);
}

/** The rendered row of the open menu that shows `label`. */
function rowOf(editor: Editor, label: string): number {
	const y = editor.render(80).findIndex((line) => stripVTControlCharacters(line).includes(label));
	assert.ok(y >= 0, `${label} is painted`);
	return y;
}

function pointer(editor: Editor, type: "press" | "click", y: number): void {
	const event: TuiMouseEvent = {
		type,
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
	};
	editor.handleMouse(event);
}

async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await run();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

describe("Editor completion lookups", () => {
	describe("a provider replacement that keeps the menu", () => {
		it("shows the new provider's rows in an open argument or Tab file menu nothing was chosen in", async () => {
			const menus = [
				{ text: "/model gp", prefix: "gp", tab: false },
				{ text: "src/de", prefix: "src/de", tab: true },
			];
			for (const menu of menus) {
				const editor = createEditor();
				editor.setAutocompleteProvider(
					provider(async () => answer(menu.prefix, `${menu.prefix}-one`, `${menu.prefix}-two`)),
				);
				if (menu.tab) {
					editor.setText(menu.text);
					editor.handleInput("\t");
				} else type(editor, menu.text);
				await settle();
				assert.ok(rows(editor).includes(`∀ ${menu.prefix}-one`), menu.text);

				editor.setAutocompleteProvider(
					provider(async () => answer(menu.prefix, `${menu.prefix}-new`, `${menu.prefix}-one`)),
					keep,
				);
				await settle();
				assert.ok(rows(editor).includes(`∀ ${menu.prefix}-new`), menu.text);
				assert.equal(editor.getText(), menu.text);
				editor.handleInput("\t");
				assert.equal(editor.getText(), menu.text.slice(0, -menu.prefix.length) + `${menu.prefix}-new`);
			}
		});

		it("asks the new provider nothing for a menu in which a row was chosen", async () => {
			let asked = 0;
			const editor = createEditor();
			editor.setAutocompleteProvider(provider(async () => answer("/g", "/go", "/global")));
			type(editor, "/g");
			await settle();
			editor.handleInput("\x1b[B");
			editor.setAutocompleteProvider(
				provider(async () => {
					asked++;
					return answer("/g", "/glimpse", "/global");
				}),
				keep,
			);
			await settle();
			assert.equal(asked, 0);
			assert.ok(rows(editor).includes("∀ /global"));
		});

		it("keeps a file menu's chosen row and the provider that offered it", async () => {
			const editor = createEditor();
			editor.setAutocompleteProvider(provider(async () => answer("src/de", "src/demo1.txt", "src/demo2.txt")));
			editor.setText("src/de");
			editor.handleInput("\t");
			await settle();
			editor.handleInput("\x1b[B");
			editor.setAutocompleteProvider(
				provider(async () => answer("src/de", "src/demo0.txt", "src/demo1.txt")),
				keep,
			);
			await settle();
			assert.ok(rows(editor).includes("∀ src/demo2.txt"));
			editor.handleInput("\t");
			assert.equal(editor.getText(), "src/demo2.txt");
		});

		it("asks the new provider for the lookup still waiting under an open menu", async () => {
			const editor = createEditor();
			const late = Promise.withResolvers<AutocompleteSuggestions>();
			editor.setAutocompleteProvider(
				provider((text) => (text === "/g" ? Promise.resolve(answer("/g", "/go", "/global")) : late.promise)),
			);
			type(editor, "/g");
			await settle();
			assert.ok(rows(editor).includes("∀ /go"));
			editor.handleInput("l");
			editor.setAutocompleteProvider(
				provider(async () => answer("/gl", "/glimpse", "/global")),
				keep,
			);
			await settle();
			late.resolve(answer("/gl", "/global"));
			await settle();
			assert.ok(rows(editor).includes("∀ /glimpse"));
		});
	});

	describe("a lookup that fails or never answers", () => {
		it("raises no unhandled rejection and leaves later lookups working", async () => {
			for (const failure of ["rejects", "throws"] as const) {
				await withoutUnhandledRejections(async () => {
					const editor = createEditor();
					editor.setAutocompleteProvider(
						provider((text) => {
							if (text !== "/ab") return Promise.resolve(answer(text, `${text}-row`));
							if (failure === "throws") throw new Error("lookup failed at once");
							return Promise.reject(new Error("lookup failed"));
						}),
					);
					type(editor, "/a");
					await settle();
					assert.ok(rows(editor).includes("∀ /a-row"), failure);
					editor.handleInput("b");
					await settle();
					// The rows answered "/a", not the text typed since: the failed lookup closes them.
					assert.equal(editor.isShowingAutocomplete(), false, failure);
					editor.handleInput("c");
					await settle();
					assert.ok(rows(editor).includes("∀ /abc-row"), failure);
				});
			}
		});

		it("closes a menu whose text found nothing once the text typed after it starts no lookup", async () => {
			const editor = createEditor();
			editor.setAutocompleteProvider(
				provider(async (text, { force }) => (force && text === "src" ? answer("src", "src/", "srcmap/") : null)),
			);
			editor.setText("src");
			editor.handleInput("\t");
			await settle();
			assert.ok(rows(editor).includes("∀ src/"));
			editor.handleInput(" ");
			await settle();
			editor.handleInput("x");
			await settle();
			assert.equal(editor.isShowingAutocomplete(), false);
			assert.ok(!rows(editor).some((line) => line.includes("srcmap/")));
		});

		it("reads nothing of an answer that comes after its text was replaced", async () => {
			let reads = 0;
			const late = Promise.withResolvers<AutocompleteSuggestions>();
			const editor = createEditor();
			editor.setAutocompleteProvider(provider(() => late.promise));
			type(editor, "/a");
			await settle();
			editor.setText("/other");
			late.resolve({
				prefix: "/a",
				get items() {
					reads++;
					return [{ value: "/apple", label: "/apple" }];
				},
			});
			await settle();
			assert.equal(reads, 0);
			assert.equal(editor.isShowingAutocomplete(), false);
		});

		it("holds the next lookup only briefly when the one it replaced never answers", async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const editor = createEditor();
			editor.setAutocompleteProvider(
				provider((text) => (text === "/a" ? new Promise(() => {}) : Promise.resolve(answer(text, `${text}-row`)))),
			);
			type(editor, "/a");
			await settle();
			editor.handleInput("b");
			await settle();
			t.mock.timers.tick(1_000);
			await settle();
			assert.ok(rows(editor).includes("∀ /ab-row"));
		});

		it("never holds later lookups behind the new provider's retry of a lookup that found nothing", async () => {
			const editor = createEditor();
			editor.setAutocompleteProvider(provider(async () => null));
			type(editor, "/a");
			await settle();
			editor.setAutocompleteProvider(
				provider((text) => (text === "/a" ? new Promise(() => {}) : Promise.resolve(answer(text, `${text}-row`)))),
				keep,
			);
			// The retry is under way, and never answers.
			await settle();
			editor.handleInput("b");
			await settle();
			assert.ok(rows(editor).includes("∀ /ab-row"));
		});
	});

	describe("rows that change before they are painted", () => {
		it("opens the new provider's menu for a lookup that found nothing at the next render, not before", async () => {
			const submitted: string[] = [];
			const editor = createEditor();
			editor.onSubmit = (text) => submitted.push(text);
			editor.setAutocompleteProvider(provider(async () => null));
			type(editor, "/zz");
			await settle();
			editor.setAutocompleteProvider(
				provider(async () => answer("/zz", "/zzq")),
				keep,
			);
			await settle();
			// Nothing was painted yet: Enter sends what the screen shows.
			editor.handleInput("\r");
			assert.deepEqual(submitted, ["/zz"]);

			type(editor, "/zz");
			await settle();
			editor.setAutocompleteProvider(
				provider(async () => answer("/zz", "/zzq")),
				keep,
			);
			await settle();
			assert.ok(rows(editor).includes("∀ /zzq"));
			editor.handleInput("\r");
			assert.deepEqual(submitted, ["/zz", "/zzq"]);
		});

		it("keeps the row chosen in the drawn menu when the text it answers is typed again before the next render", async () => {
			for (const key of ["\t", "\r"] as const) {
				for (const answered of [false, "rows", "nothing"] as const) {
					const submitted: string[] = [];
					const editor = createEditor();
					editor.onSubmit = (text) => submitted.push(text);
					let reordered = false;
					editor.setAutocompleteProvider(
						provider(async (text) => {
							if (!reordered) return answer(text, "/apple", "/apricot");
							return text === "/ab" && answered === "nothing"
								? null
								: answer(text, "/amber", "/apple", "/apricot");
						}),
					);
					type(editor, "/a");
					await settle();
					editor.handleInput("\x1b[B");
					assert.ok(rows(editor).includes("∀ /apricot"));
					reordered = true;
					editor.handleInput("b");
					if (answered) await settle();
					editor.handleInput("\x7f");
					await settle();
					editor.handleInput(key);
					const label = `${JSON.stringify(key)} answered=${answered}`;
					if (key === "\t") assert.equal(editor.getText(), "/apricot", label);
					else assert.deepEqual(submitted, ["/apricot"], label);
				}
			}
		});

		it("takes the rows for newly typed text when a key acts on a menu drawn for the text before", async () => {
			const editor = createEditor();
			editor.setAutocompleteProvider(
				provider(async (text) =>
					text === "/a" ? answer("/a", "/apple", "/apricot") : answer("/ab", "/abacus", "/abbey"),
				),
			);
			type(editor, "/a");
			await settle();
			rows(editor);
			editor.handleInput("b");
			await settle();
			editor.handleInput("\t");
			assert.equal(editor.getText(), "/abacus");
		});

		it("reads an answer's rows when it comes, not when the menu is drawn", async () => {
			let retired = false;
			const row = {
				get value(): string {
					if (retired) throw new Error("lookup data retired");
					return "/abc";
				},
				label: "/abc",
			};
			let applied: unknown;
			const editor = createEditor();
			editor.setAutocompleteProvider({
				getSuggestions: async () => ({ prefix: "/a", items: [row] }),
				applyCompletion: (lines, cursorLine, cursorCol, item) => {
					applied = item;
					return { lines, cursorLine, cursorCol };
				},
			});
			type(editor, "/a");
			await settle();
			retired = true;
			assert.ok(rows(editor).includes("∀ /abc"));
			editor.handleInput("\t");
			assert.equal(applied, row);
		});

		it("continues a menu not drawn yet through edits made before the rows for the first edit came", async () => {
			const files = ["main.ts", "mod.ts", "model.ts", "notes.md"];
			for (const variant of ["chars", "left", "slashLeft"] as const) {
				const waiting: Array<() => void> = [];
				let slow = false;
				const editor = createEditor();
				editor.setAutocompleteProvider(
					provider(async (text, { force }) => {
						if (slow) await new Promise<void>((resolve) => waiting.push(resolve));
						const command = /^\/(\S*)$/.exec(text);
						if (command && !force) {
							const items = ["/model", "/mode", "/help"].filter((name) => name.startsWith(text));
							return items.length === 0 ? null : answer(text, ...items);
						}
						const token = /(\S*)$/.exec(text)?.[1] ?? "";
						const items = files.filter((name) => name.startsWith(token));
						return force && items.length > 0 ? answer(token, ...items) : null;
					}),
				);
				if (variant === "slashLeft") {
					type(editor, "/mo");
					await settle();
					slow = true;
					// The rows for "/mo" came but were not drawn: the edits go on as they would on a drawn menu.
					editor.handleInput("d");
					await settle();
					editor.handleInput("\x1b[D");
				} else {
					type(editor, "cat ");
					editor.handleInput("\t");
					await settle();
					slow = true;
					editor.handleInput("m");
					await settle();
					editor.handleInput(variant === "left" ? "\x1b[D" : "o");
				}
				slow = false;
				for (const resolve of waiting.splice(0)) resolve();
				await settle();
				await settle();
				const expected = { chars: "∀ mod.ts", left: "∀ main.ts", slashLeft: "∀ /model" }[variant];
				assert.ok(rows(editor).includes(expected), `${variant}: ${rows(editor).join(" | ")}`);
			}
		});

		it("continues, with an edit, rows that came for a text the screen shows nothing for", async () => {
			let found = false;
			const editor = createEditor();
			editor.setAutocompleteProvider(
				provider(async (text) => {
					if (text === "/z") return answer("/z", "/zap", "/zzq");
					if (text === "/zz" && found) return answer("/zz", "/zzq");
					return null;
				}),
			);
			type(editor, "/zz");
			await settle();
			assert.equal(rows(editor).length > 0 && editor.isShowingAutocomplete(), false);
			found = true;
			editor.handleInput("x");
			await settle();
			editor.handleInput("\x7f");
			await settle();
			// "/zz" now has rows, not drawn yet; moving the cursor goes on from them, as from a menu on screen.
			editor.handleInput("\x1b[D");
			await settle();
			assert.ok(rows(editor).includes("∀ /zap"), rows(editor).join(" | "));
		});

		it("stops, with Esc, a lookup that continues a menu not drawn yet", async () => {
			const late = Promise.withResolvers<AutocompleteSuggestions>();
			const editor = createEditor();
			editor.setAutocompleteProvider(
				provider((text) => (text === "/m" ? Promise.resolve(answer("/m", "/model", "/mode")) : late.promise)),
			);
			type(editor, "/m");
			await settle();
			editor.handleInput("o");
			editor.handleInput("\x1b");
			late.resolve(answer("/mo", "/model", "/mode"));
			await settle();
			assert.equal(editor.isShowingAutocomplete(), false);
			assert.ok(!rows(editor).some((line) => line.includes("/model")));
		});

		it("chooses nothing with a press on rows replaced since they were painted", async () => {
			const editor = createEditor();
			editor.setAutocompleteProvider(
				provider(async (text) =>
					text === "/a" ? answer("/a", "/apple", "/apricot") : answer("/ab", "/abacus", "/abbey"),
				),
			);
			type(editor, "/a");
			await settle();
			const y = rowOf(editor, "/apricot");
			editor.handleInput("b");
			await settle();
			// "/abbey" took the painted "/apricot" row's place but has not been painted.
			pointer(editor, "press", y);
			pointer(editor, "click", y);
			assert.equal(editor.getText(), "/ab");
			assert.equal(rowOf(editor, "/abbey"), y);
			pointer(editor, "press", y);
			pointer(editor, "click", y);
			assert.equal(editor.getText(), "/abbey");
		});

		it("chooses nothing with a click whose press was on rows replaced while the button was held", async () => {
			const editor = createEditor();
			editor.setAutocompleteProvider(
				provider(async (text) =>
					text === "/a" ? answer("/a", "/apple", "/apricot") : answer("/ab", "/abacus", "/abbey"),
				),
			);
			type(editor, "/a");
			await settle();
			const y = rowOf(editor, "/apricot");
			pointer(editor, "press", y);
			editor.handleInput("b");
			await settle();
			assert.equal(rowOf(editor, "/abbey"), y);
			pointer(editor, "click", y);
			assert.equal(editor.getText(), "/ab");
		});
	});
});
