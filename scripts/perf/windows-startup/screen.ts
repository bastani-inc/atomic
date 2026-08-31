import { Terminal } from "@xterm/headless";

export interface ScreenSnapshot {
	readonly atNs: string;
	readonly text: string;
	readonly lines: readonly string[];
	readonly attributes: readonly string[];
	readonly cursor: { readonly x: number; readonly y: number };
	readonly coherent: boolean;
	readonly finalIdentity: boolean;
}

export interface ScreenObservation extends ScreenSnapshot {
	readonly complete: boolean;
}

export interface StartupScreenOptions {
	readonly cols?: number;
	readonly rows?: number;
	readonly animationIntervalMs?: number;
}

const FINAL_MANIFESTO = ["We question,", "we break away from what is accepted.", "Engineering matters."] as const;

function frameKey(snapshot: ScreenSnapshot): string {
	return `${snapshot.text}\n${snapshot.attributes.join("\n")}\n@${snapshot.cursor.x},${snapshot.cursor.y}`;
}

export class StartupScreenTracker {
	readonly terminal: Terminal;
	private readonly version: string;
	private readonly animationIntervalNs: bigint;
	private lastAtNs = 0n;
	private lastSnapshot: ScreenSnapshot | undefined;
	private qualifyingFrame: { readonly key: string; readonly atNs: bigint } | undefined;

	constructor(version: string, options: StartupScreenOptions = {}) {
		this.version = version;
		this.animationIntervalNs = BigInt(options.animationIntervalMs ?? 80) * 1_000_000n;
		this.terminal = new Terminal({ cols: options.cols ?? 120, rows: options.rows ?? 40, allowProposedApi: true });
	}

	async write(data: string | Uint8Array, atNs: bigint = process.hrtime.bigint()): Promise<ScreenObservation> {
		await new Promise<void>((resolve) => this.terminal.write(data, resolve));
		return this.observe(atNs);
	}

	observe(atNs: bigint = process.hrtime.bigint()): ScreenObservation {
		if (atNs < this.lastAtNs) throw new Error("Screen observation timestamps must be monotonic");
		this.lastAtNs = atNs;
		const snapshot = this.capture(atNs);
		let complete = false;
		if (snapshot.coherent && snapshot.finalIdentity) {
			const key = frameKey(snapshot);
			if (this.qualifyingFrame?.key === key && atNs - this.qualifyingFrame.atNs >= this.animationIntervalNs) {
				complete = true;
			} else if (this.qualifyingFrame?.key !== key) {
				this.qualifyingFrame = { key, atNs };
			}
		} else {
			this.qualifyingFrame = undefined;
		}
		this.lastSnapshot = snapshot;
		return { ...snapshot, complete };
	}

	snapshot(): ScreenSnapshot {
		return this.lastSnapshot ?? this.capture(this.lastAtNs);
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private capture(atNs: bigint): ScreenSnapshot {
		const buffer = this.terminal.buffer.active;
		const lines: string[] = [];
		const attributes: string[] = [];
		for (let row = 0; row < this.terminal.rows; row += 1) {
			const line = buffer.getLine(buffer.viewportY + row);
			lines.push(line?.translateToString(true) ?? "");
			const cells: string[] = [];
			if (line) {
				for (let column = 0; column < line.length; column += 1) {
					const cell = line.getCell(column);
					if (!cell || cell.getChars() === "") continue;
					cells.push(
						`${column}:${cell.isBold()}:${cell.isDim()}:${cell.isItalic()}:${cell.getFgColorMode()}:${cell.getFgColor()}`,
					);
				}
			}
			attributes.push(cells.join(","));
		}
		const cursor = { x: buffer.cursorX, y: buffer.cursorY };
		const title = `Atomic v${this.version}`;
		const titleVisible = lines.some((line) => line.includes(title));
		const editorRow = lines.findIndex((line) => line.startsWith("❯ "));
		const cursorInEditor = editorRow >= 0 && cursor.y === editorRow && cursor.x >= 2;
		const coherent = titleVisible && cursorInEditor;
		const finalLineRow = lines.findIndex((line) => line.includes(FINAL_MANIFESTO[2]));
		const finalLineStart = finalLineRow < 0 ? -1 : lines[finalLineRow]!.indexOf(FINAL_MANIFESTO[2]);
		const finalLine = finalLineRow < 0 ? undefined : buffer.getLine(buffer.viewportY + finalLineRow);
		const finalLineSettled = finalLineStart >= 0 && (finalLine?.getCell(finalLineStart)?.isBold() ?? 0) !== 0;
		const finalIdentity =
			FINAL_MANIFESTO.every((line) => lines.some((candidate) => candidate.includes(line))) && finalLineSettled;
		return {
			atNs: atNs.toString(),
			text: lines.join("\n"),
			lines,
			attributes,
			cursor,
			coherent,
			finalIdentity,
		};
	}
}
