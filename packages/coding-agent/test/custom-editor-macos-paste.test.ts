import { type Terminal, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const EMPTY_BRACKETED_PASTE = "\x1b[200~\x1b[201~";
const F9_SEQUENCE = "\x1b[20~";
const KITTY_SUPER_V = "\x1b[118;9u";
const KITTY_SUPER_V_REPEAT = "\x1b[118;9:2u";
const KITTY_CTRL_V_REPEAT = "\x1b[118;5:2u";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
	try {
		run();
	} finally {
		if (platformDescriptor) {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	}
}

function createEditor(userBindings: ConstructorParameters<typeof KeybindingsManager>[0] = {}): CustomEditor {
	return new CustomEditor(new TUI(new FakeTerminal()), getEditorTheme(), new KeybindingsManager(userBindings));
}

describe("CustomEditor macOS empty paste routing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("inserts non-empty macOS bracketed paste text without calling onPasteImage", () => {
		withPlatform("darwin", () => {
			const editor = createEditor();
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			editor.setText("draft");

			editor.handleInput("\x1b[200~hello\x1b[201~");

			expect(pasteImageCalls).toBe(0);
			expect(editor.getText()).toBe("drafthello");
		});
	});

	it("does not call onPasteImage for empty bracketed paste on linux", () => {
		withPlatform("linux", () => {
			const editor = createEditor();
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			editor.setText("seed");

			editor.handleInput(EMPTY_BRACKETED_PASTE);

			expect(pasteImageCalls).toBe(0);
			expect(editor.getText()).toBe("seed");
		});
	});

	it("does not call onPasteImage for empty bracketed paste on win32", () => {
		withPlatform("win32", () => {
			const editor = createEditor();
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			editor.setText("seed");

			editor.handleInput(EMPTY_BRACKETED_PASTE);

			expect(pasteImageCalls).toBe(0);
			expect(editor.getText()).toBe("seed");
		});
	});

	it("routes the explicit pasteImage keybinding through onPasteImage once", () => {
		withPlatform("linux", () => {
			const editor = createEditor({ "app.clipboard.pasteImage": "f9" });
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			editor.setText("seed");

			editor.handleInput(F9_SEQUENCE);

			expect(pasteImageCalls).toBe(1);
			expect(editor.getText()).toBe("seed");
		});
	});

	it("consumes the explicit pasteImage keybinding safely when onPasteImage is missing", () => {
		withPlatform("linux", () => {
			const editor = createEditor({ "app.clipboard.pasteImage": "f9" });
			editor.setText("seed");

			expect(() => editor.handleInput(F9_SEQUENCE)).not.toThrow();
			expect(editor.getText()).toBe("seed");
		});
	});

	it("does not treat partial or embedded empty-paste sequences as image paste", () => {
		withPlatform("darwin", () => {
			const sequences = [
				"\x1b[200~",
				"\x1b[201~",
				`prefix${EMPTY_BRACKETED_PASTE}`,
				`${EMPTY_BRACKETED_PASTE}suffix`,
				`\x1b[200~ \x1b[201~`,
			];

			for (const sequence of sequences) {
				const editor = createEditor();
				let pasteImageCalls = 0;
				editor.onPasteImage = () => {
					pasteImageCalls += 1;
				};
				editor.setText("seed");

				editor.handleInput(sequence);

				expect(pasteImageCalls, JSON.stringify(sequence)).toBe(0);
			}
		});
	});

	it("routes exact empty bracketed paste on darwin to onPasteImage once without changing the draft", () => {
		withPlatform("darwin", () => {
			const editor = createEditor();
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			const seeded = "keep-me-byte-for-byte";
			editor.setText(seeded);

			editor.handleInput(EMPTY_BRACKETED_PASTE);

			expect(pasteImageCalls).toBe(1);
			expect(editor.getText()).toBe(seeded);
		});
	});

	it("prefers an extension shortcut over exact empty bracketed paste on darwin", () => {
		withPlatform("darwin", () => {
			const editor = createEditor();
			let extensionCalls = 0;
			let pasteImageCalls = 0;
			editor.onExtensionShortcut = (data) => {
				if (data !== EMPTY_BRACKETED_PASTE) return false;
				extensionCalls += 1;
				return true;
			};
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			const seeded = "keep-me-byte-for-byte";
			editor.setText(seeded);

			editor.handleInput(EMPTY_BRACKETED_PASTE);

			expect(extensionCalls).toBe(1);
			expect(pasteImageCalls).toBe(0);
			expect(editor.getText()).toBe(seeded);
		});
	});

	it("prefers an extension shortcut over Kitty-protocol super+v on darwin", () => {
		withPlatform("darwin", () => {
			const editor = createEditor();
			let extensionCalls = 0;
			let pasteImageCalls = 0;
			editor.onExtensionShortcut = (data) => {
				if (data !== KITTY_SUPER_V) return false;
				extensionCalls += 1;
				return true;
			};
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			const seeded = "keep-me-byte-for-byte";
			editor.setText(seeded);

			editor.handleInput(KITTY_SUPER_V);

			expect(extensionCalls).toBe(1);
			expect(pasteImageCalls).toBe(0);
			expect(editor.getText()).toBe(seeded);
		});
	});

	it("routes Kitty-protocol super+v on darwin to onPasteImage once without changing the draft", () => {
		withPlatform("darwin", () => {
			const editor = createEditor();
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			const seeded = "keep-me-byte-for-byte";
			editor.setText(seeded);

			editor.handleInput(KITTY_SUPER_V);

			expect(pasteImageCalls).toBe(1);
			expect(editor.getText()).toBe(seeded);
		});
	});

	it("does not repeat image paste for Kitty-protocol super+v repeat events on darwin", () => {
		withPlatform("darwin", () => {
			const editor = createEditor();
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			editor.setText("seed");

			editor.handleInput(KITTY_SUPER_V_REPEAT);

			expect(pasteImageCalls).toBe(0);
			expect(editor.getText()).toBe("seed");
		});
	});

	it("does not call onPasteImage for Kitty-protocol super+v on linux", () => {
		withPlatform("linux", () => {
			const editor = createEditor();
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			editor.setText("seed");

			editor.handleInput(KITTY_SUPER_V);

			expect(pasteImageCalls).toBe(0);
			expect(editor.getText()).toBe("seed");
		});
	});

	it("does not repeat the explicit pasteImage keybinding for Kitty repeat events", () => {
		withPlatform("linux", () => {
			const editor = createEditor({ "app.clipboard.pasteImage": "ctrl+v" });
			let pasteImageCalls = 0;
			editor.onPasteImage = () => {
				pasteImageCalls += 1;
			};
			editor.setText("seed");

			editor.handleInput(KITTY_CTRL_V_REPEAT);

			expect(pasteImageCalls).toBe(0);
			expect(editor.getText()).toBe("seed");
		});
	});

	it("consumes macOS empty paste safely when onPasteImage is missing", () => {
		withPlatform("darwin", () => {
			const editor = createEditor();
			editor.setText("seed");

			expect(() => editor.handleInput(EMPTY_BRACKETED_PASTE)).not.toThrow();
			expect(editor.getText()).toBe("seed");
		});
	});
});
