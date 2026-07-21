import {
	Loader,
	visibleWidth,
	type Component,
	type LoaderIndicatorOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const G1_BODY = [
	"###            ###  ",
	" ###          ###   ",
	"  ###        ###    ",
	"   ############     ",
	"    ###    ###      ",
	"     ###  ###       ",
	"      ####          ",
] as const;
const G1_PHASES = [
	"000            000  ",
	" 111          111   ",
	"  222        222    ",
	"   333333333333     ",
	"    444    444      ",
	"     555  555       ",
	"      6666          ",
] as const;
const BRAILLE_BITS = [[1, 8], [2, 16], [4, 32], [64, 128]] as const;

function packedG1(step: number): string[] {
	const rows = ["", ""];
	for (let blockRow = 0; blockRow < 2; blockRow++) {
		for (let blockColumn = 0; blockColumn < 10; blockColumn++) {
			let bits = 0;
			for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
				const row = blockRow * 4 + y;
				const column = blockColumn * 2 + x;
				if (row < G1_BODY.length && G1_BODY[row]![column] !== " " && Number(G1_PHASES[row]![column]) <= Math.min(step, 6)) {
					bits |= BRAILLE_BITS[y]![x];
				}
			}
			rows[blockRow] += bits === 0 ? " " : String.fromCodePoint(0x2800 + bits);
		}
	}
	const suffix = step < 7 ? "" : step === 7 ? "-" : step === 8 ? "--" : "--*";
	return [`${rows[0]}${suffix.padEnd(3)}`, `${rows[1]}   `];
}

export const ATOMIC_WORKING_MARK_FRAMES: readonly (readonly string[])[] =
	Array.from({ length: 12 }, (_, step) => packedG1(Math.min(step, 9)));
export const ATOMIC_WORKING_FRAME_MS = 240;

export interface WorkingActivity {
	type?: string;
	toolName?: string;
	paths?: readonly string[];
	command?: string;
	action?: string;
}

const ARTIFACT_DIRECTORY = /(?:^|[/\\])(?:docs?|specs?|reports?)(?:[/\\]|$)/i;
const ARTIFACT_FORMAT = /(?:^|[/\\])(?:(?:spec|report)(?:\.|$)|[^/\\]*[._-](?:spec|report)(?:\.|$)|[^/\\]*\.(?:md|mdx|rst)$)/i;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|rs|py|pyw|go|c|h|cc|cpp|cxx|hxx|hpp|java|kt|kts|cs|rb|php|swift|scala|sh|bash|zsh|fish|lua|ex|exs|erl|hrl|clj|cljs|dart|vue|svelte)$/i;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s*/;
const DIRECT_VERIFICATION = /^(?:vitest|jest|pytest|tsc|eslint|biome|typecheck|lint)(?:\s|$)/i;
const BUN_VERIFICATION = /^bun\s+(?:test(?:\s|$)|run\s+(?:test|typecheck|lint)(?::[A-Za-z0-9_.-]+)?(?:\s|$))/i;
const BUNX_VERIFICATION = /^bunx\s+(?:vitest|jest|tsc|eslint|biome)(?:\s|$)/i;
const NATIVE_TEST_VERIFICATION = /^(?:(?:cargo|go)\s+test|python(?:3(?:\.\d+)?)?\s+-m\s+pytest)(?:\s|$)/i;
const INSPECTION_TOOLS = new Set([
	"read", "search", "code_search", "grep", "find", "ls", "fetch", "fetch_content",
	"get_search_content", "web_search", "web_fetch", "open_url",
]);
const WORKFLOW_ACTIVITY_TYPES = new Set(["workflow_dispatch", "workflow_progress"]);
const WORKFLOW_ACTIVE_ACTIONS = new Set([
	"run", "dispatch", "progress", "status", "send", "pause", "interrupt", "quit", "resume", "reload",
]);

function isArtifactPath(path: string): boolean {
	if (ARTIFACT_DIRECTORY.test(path)) return true;
	if (SOURCE_FILE.test(path)) return false;
	return ARTIFACT_FORMAT.test(path);
}

function isVerificationCommand(command: string): boolean {
	return command.split(/\r?\n|&&|\|\||;/).some((segment) => {
		let candidate = segment.trimStart();
		if (/^env(?:\s|$)/.test(candidate)) candidate = candidate.replace(/^env\s+/, "");
		let assignment = candidate.match(ENV_ASSIGNMENT);
		while (assignment) {
			candidate = candidate.slice(assignment[0].length);
			assignment = candidate.match(ENV_ASSIGNMENT);
		}
		return BUN_VERIFICATION.test(candidate) || BUNX_VERIFICATION.test(candidate) || NATIVE_TEST_VERIFICATION.test(candidate) || DIRECT_VERIFICATION.test(candidate);
	});
}

export function workingLabelForActivity(activity: WorkingActivity): string {
	const type = activity.type?.toLowerCase() ?? "";
	const toolName = activity.toolName?.toLowerCase() ?? "";
	if ((toolName === "write" || toolName === "edit") && activity.paths?.some(isArtifactPath)) return "Making it inspectable";
	if (WORKFLOW_ACTIVITY_TYPES.has(type) || (toolName === "workflow" && WORKFLOW_ACTIVE_ACTIONS.has(activity.action ?? ""))) return "Proving the path";
	if (toolName === "test" || (toolName === "bash" && isVerificationCommand(activity.command ?? ""))) return "Demanding evidence";
	if (type.includes("thinking") || type.includes("reasoning")) return "Questioning the defaults";
	if (INSPECTION_TOOLS.has(toolName)) return "Checking the machinery";
	if (toolName === "edit" || toolName === "write") return "Building assurance";
	return "On it";
}

function unquoteHashlinePath(path: string): string {
	const quote = path[0];
	return (quote === '"' || quote === "'") && path.at(-1) === quote ? path.slice(1, -1) : path;
}

function toolPaths(toolName: string, record: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const pathValue = record.path ?? record.filePath ?? record.file_path;
	if (typeof pathValue === "string") paths.push(pathValue);
	if (toolName === "edit" && typeof record.input === "string") {
		for (const match of record.input.matchAll(/^\[([^\]\r\n]+)#[0-9A-Fa-f]{4}\][\t ]*\r?$/gm)) {
			paths.push(unquoteHashlinePath(match[1]!));
		}
	}
	return paths;
}

export function workingLabelForTool(toolName: string, args: unknown, type = "tool"): string {
	const normalized = toolName.toLowerCase();
	const record = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
	return workingLabelForActivity({
		type,
		toolName: normalized,
		paths: toolPaths(normalized, record),
		command: typeof record.command === "string" ? record.command : undefined,
		action: typeof record.action === "string" ? record.action.toLowerCase() : undefined,
	});
}

function lastActiveLabel(active: ReadonlyMap<string, string>): string | undefined {
	return [...active.values()].at(-1);
}

export function startWorkingActivity(active: Map<string, string>, id: string, label: string): string {
	if (!active.has(id)) active.set(id, label);
	return lastActiveLabel(active) ?? label;
}

export function completeWorkingActivity(active: Map<string, string>, id: string, isError: boolean): string | undefined {
	const completed = active.get(id);
	active.delete(id);
	return lastActiveLabel(active) ?? (!isError && completed === "Demanding evidence" ? completed : undefined);
}

export interface AtomicWorkingStatusOptions {
	frame?: number;
	message?: string;
	spinnerColor?: (text: string) => string;
	messageColor?: (text: string) => string;
}

function styleMark(line: string, color: (text: string) => string): string {
	return [...line].map((character) => character === "*" ? color(character) : character === " " ? " " : theme.fg("dim", character)).join("");
}

export class AtomicWorkingStatusComponent implements Component {
	private readonly options: AtomicWorkingStatusOptions;

	constructor(options: AtomicWorkingStatusOptions = {}) {
		this.options = options;
	}

	render(width: number): string[] {
		const frame = ATOMIC_WORKING_MARK_FRAMES[(this.options.frame ?? 0) % ATOMIC_WORKING_MARK_FRAMES.length]!;
		const color = this.options.spinnerColor ?? ((text: string) => theme.bold(theme.fg("accent", text)));
		const messageColor = this.options.messageColor ?? ((text: string) => theme.fg("muted", text));
		const message = this.options.message ?? "On it";
		const second = ` ${styleMark(frame[1]!, color)}  ${messageColor(message)}`;
		if (visibleWidth(second) > width) return [];
		return [` ${styleMark(frame[0]!, color)}`, second];
	}

	invalidate(): void {}
}

/** Loader-compatible ordinary working surface. Explicit extension indicators delegate to pi-tui unchanged. */
export class AtomicWorkingLoader implements Component {
	private readonly ui: TUI;
	private readonly spinnerColor: (text: string) => string;
	private readonly messageColor: (text: string) => string;
	private message: string;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private delegate: Loader | undefined;

	constructor(
		ui: TUI,
		spinnerColor: (text: string) => string,
		messageColor: (text: string) => string,
		message = "On it",
		indicator?: LoaderIndicatorOptions,
	) {
		this.ui = ui;
		this.spinnerColor = spinnerColor;
		this.messageColor = messageColor;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return this.delegate?.render(width) ?? new AtomicWorkingStatusComponent({ frame: this.frame, message: this.message, spinnerColor: this.spinnerColor, messageColor: this.messageColor }).render(width);
	}

	start(): void {
		if (this.delegate) return this.delegate.start();
		this.stop();
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % ATOMIC_WORKING_MARK_FRAMES.length;
			this.ui.requestRender();
		}, ATOMIC_WORKING_FRAME_MS);
		this.timer.unref?.();
	}

	stop(): void {
		this.delegate?.stop();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	setMessage(message: string): void {
		this.message = message;
		this.delegate?.setMessage(message);
		this.ui.requestRender();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.stop();
		this.delegate = indicator ? new Loader(this.ui, this.spinnerColor, this.messageColor, this.message, indicator) : undefined;
		this.frame = process.env.ATOMIC_REDUCED_MOTION === "1" ? 9 : 0;
		if (!this.delegate && process.env.ATOMIC_REDUCED_MOTION !== "1") this.start();
	}

	invalidate(): void {}
}

export function atomicWorkingFrame(now = Date.now()): number {
	if (process.env.ATOMIC_REDUCED_MOTION === "1") return 9;
	return Math.floor(now / ATOMIC_WORKING_FRAME_MS) % ATOMIC_WORKING_MARK_FRAMES.length;
}
