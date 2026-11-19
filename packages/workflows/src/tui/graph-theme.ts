/**
 * Catppuccin Mocha role-mapped tokens for the orchestrator overlay.
 *
 * cross-ref: DESIGN.md §2 (Colors), §4 (Elevation), §5 (Components)
 *            PRODUCT.md (Aesthetic Direction — Catppuccin Mocha canonical)
 *
 * Roles, not raw hex, are referenced by every renderer. A render-time
 * `deriveGraphTheme()` accepts an optional terminal-resolved theme so
 * adaptive palettes (light fallback, NO_COLOR pass-through) can supply
 * overrides without forking the renderer.
 */

import { colorToRgb, foregroundAnsi, parseColor } from "@bastani/atomic-tui";

// ---------------------------------------------------------------------------
// Canonical palette (Catppuccin Mocha)
// ---------------------------------------------------------------------------

const MOCHA = {
	crust: "#11111b",
	mantle: "#181825",
	base: "#1e1e2e",
	surface0: "#313244",
	surface1: "#45475a",
	surface2: "#585b70",
	overlay0: "#6c7086",
	overlay1: "#7f849c",
	text: "#cdd6f4",
	subtext0: "#a6adc8",
	blue: "#89b4fa",
	green: "#a6e3a1",
	yellow: "#f9e2af",
	red: "#f38ba8",
	mauve: "#cba6f7",
	sky: "#89dceb",
	lavender: "#b4befe",
} as const;

const LATTE = { text: "#4c4f69" } as const;

/**
 * Optional generic theme overrides accepted by `deriveGraphTheme`.
 * Keys mirror the role names below; any field omitted falls back to Mocha.
 */
export interface GenericTheme {
	bg?: string;
	backgroundPanel?: string;
	backgroundToolSuccess?: string;
	backgroundToolError?: string;
	backgroundElement?: string;
	surface?: string;
	selection?: string;
	border?: string;
	borderDim?: string;
	borderActive?: string;
	text?: string;
	textMuted?: string;
	dim?: string;
	toolTitle?: string;
	toolOutput?: string;
	accent?: string;
	mauve?: string;
	success?: string;
	warning?: string;
	info?: string;
	error?: string;
}

/**
 * Role-mapped tokens consumed by every renderer in `src/tui/`.
 *
 * The `border*` family is split into three steps so components can pick
 * the right tonal weight: `borderDim` for quiet rules, `border` for the
 * default, `borderActive` for emphasised panels. Status colors map
 * one-to-one to the orchestrator's session vocabulary (DESIGN.md
 * "Status-Is-Truth" — never used decoratively).
 */
export interface GraphTheme {
	/** Strata, deepest first */
	bg: string;
	backgroundPanel: string;
	backgroundToolSuccess: string;
	backgroundToolError: string;
	backgroundElement: string;
	surface: string;
	selection: string;

	/** Borders, dimmest first */
	border: string;
	borderDim: string;
	borderActive: string;

	/** Text, brightest first */
	text: string;
	textMuted: string;
	dim: string;
	/** Host tool-card title (`toolTitle`, Catppuccin lavender). */
	toolTitle: string;
	/** Host tool-card body (`toolOutput`, usually the same as `text`). */
	toolOutput: string;

	/** Accents */
	accent: string;
	mauve: string;

	/** Palette slots have no fixed RGB. Keep a live stage's slot when its host uses one. */
	stagePaletteFg?: (role: "warning" | "info") => string | undefined;

	/** Statuses */
	success: string;
	warning: string;
	info: string;
	error: string;
}

export function deriveGraphTheme(theme: GenericTheme = {}): GraphTheme {
	return {
		bg: theme.bg ?? MOCHA.base,
		backgroundPanel: theme.backgroundPanel ?? MOCHA.surface0,
		backgroundToolSuccess: theme.backgroundToolSuccess ?? theme.backgroundPanel ?? MOCHA.surface0,
		backgroundToolError: theme.backgroundToolError ?? theme.backgroundPanel ?? MOCHA.surface0,
		backgroundElement: theme.backgroundElement ?? MOCHA.surface0,
		surface: theme.surface ?? MOCHA.crust,
		selection: theme.selection ?? MOCHA.surface1,

		border: theme.border ?? MOCHA.overlay0,
		borderDim: theme.borderDim ?? MOCHA.surface2,
		borderActive: theme.borderActive ?? MOCHA.overlay1,

		text: theme.text ?? MOCHA.text,
		textMuted: theme.textMuted ?? MOCHA.subtext0,
		dim: theme.dim ?? MOCHA.overlay1,
		toolTitle: theme.toolTitle ?? MOCHA.lavender,
		toolOutput: theme.toolOutput ?? MOCHA.text,

		accent: theme.accent ?? MOCHA.blue,
		mauve: theme.mauve ?? MOCHA.mauve,

		success: theme.success ?? MOCHA.green,
		warning: theme.warning ?? MOCHA.yellow,
		info: theme.info ?? MOCHA.sky,
		error: theme.error ?? MOCHA.red,
	};
}

// ---------------------------------------------------------------------------
// Pi runtime theme bridge (additive)
// ---------------------------------------------------------------------------

/**
 * Structural subset of Pi's `Theme` class. The orchestrator overlay's
 * `ctx.ui.custom` factory receives a live `Theme` instance whose
 * concrete class lives in `@bastani/atomic`; we cannot import
 * that runtime type from a `.ts` extension shipped to pi without
 * pulling the entire host into our type graph. Instead we accept any
 * object that exposes the two ANSI accessors we need and feature-detect
 * at call time. Hosts that don't expose them — or test mocks that
 * pass `{}` — fall back to the Catppuccin defaults below.
 *
 * Both accessors return a pre-built SGR sequence such as
 * `\x1b[38;2;R;G;Bm` (truecolor) or `\x1b[38;5;Nm` (xterm-256), per
 * Pi's `Bun.color(..)` output. `parsePiAnsiToHex` converts those back
 * into `#rrggbb` tokens that the existing renderer pipeline consumes
 * via `hexToAnsi` / `hexBg`.
 */
export interface PiRuntimeTheme {
	readonly name?: string;
	getFgAnsi?: (color: string) => string;
	getStyleLevel?: () => number;
	getBgAnsi?: (color: string) => string;
}

/**
 * Standard xterm-256 palette converted to hex. The 6×6×6 colour cube
 * (indices 16–231) and the 24-step grayscale ramp (232–255) are
 * deterministic and shared across virtually every terminal; the basic
 * 0–15 slots are user-configurable, so for those indices we return
 * `undefined` and let the caller fall back to the Mocha defaults.
 */
function xterm256ToHex(idx: number): string | undefined {
	if (!Number.isInteger(idx) || idx < 0 || idx > 255) return undefined;
	if (idx < 16) return undefined; // ambient terminal palette — unknown
	if (idx >= 232) {
		const level = 8 + (idx - 232) * 10;
		const hex = level.toString(16).padStart(2, "0");
		return `#${hex}${hex}${hex}`;
	}
	const cube = idx - 16;
	const steps = [0, 95, 135, 175, 215, 255];
	const r = steps[Math.floor(cube / 36)]!;
	const g = steps[Math.floor((cube % 36) / 6)]!;
	const b = steps[cube % 6]!;
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Parse a Pi ANSI colour sequence back to a `#rrggbb` token.
 * Accepts truecolor (`\x1b[38;2;R;G;Bm` / `\x1b[48;2;R;G;Bm`) and
 * xterm-256 (`\x1b[38;5;Nm` / `\x1b[48;5;Nm`). Default resets
 * (`\x1b[39m` / `\x1b[49m`) and any unparseable input return
 * `undefined`, signalling the caller to fall back to the Mocha token.
 */
function parsePiAnsiToHex(ansi: string | undefined): string | undefined {
	if (typeof ansi !== "string" || ansi.length === 0) return undefined;
	const truecolor = /\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (truecolor) {
		const r = Math.min(255, Math.max(0, parseInt(truecolor[1]!, 10)));
		const g = Math.min(255, Math.max(0, parseInt(truecolor[2]!, 10)));
		const b = Math.min(255, Math.max(0, parseInt(truecolor[3]!, 10)));
		return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
	}
	const indexed = /\x1b\[(?:38|48);5;(\d{1,3})m/.exec(ansi);
	if (indexed) {
		return xterm256ToHex(parseInt(indexed[1]!, 10));
	}
	return undefined;
}

/**
 * Safely invoke a Pi theme accessor that may throw on unknown tokens.
 * Pi's `Theme.getFgAnsi` throws when the requested key is missing from
 * the current theme; we want feature detection without surfacing the
 * throw to overlay mount.
 */
function tryPiAccessor(
	theme: PiRuntimeTheme,
	fn: ((color: string) => string) | undefined,
	color: string,
): string | undefined {
	if (typeof fn !== "function") return undefined;
	try {
		return Reflect.apply(fn, theme, [color]);
	} catch {
		return undefined;
	}
}

/** Round the peak hue once to a basic foreground. Relative channel strengths keep pastel yellow yellow, not white. */
function basicForeground(hex: string): string {
	const { r, g, b } = colorToRgb(parseColor(hex));
	const hi = Math.max(r, g, b);
	const lo = Math.min(r, g, b);
	if (hi === lo) return `\x1b[${hi < 64 ? 30 : hi < 160 ? 90 : hi < 224 ? 37 : 97}m`;
	const mid = (hi + lo) / 2;
	const slot = Number(r >= mid) + 2 * Number(g >= mid) + 4 * Number(b >= mid);
	return `\x1b[${(hi >= 192 ? 90 : 30) + slot}m`;
}

function stagePeak(
	ansi: string | undefined,
	hex: string,
	level: number,
	depth: number | undefined,
): string | undefined {
	const indexed = /^\x1b\[38;5;(\d{1,3})m$/.exec(ansi ?? "");
	const index = indexed ? Number(indexed[1]) : undefined;
	if (index !== undefined && index < 16) return `\x1b[${index < 8 ? 30 + index : 90 + index - 8}m`;
	if (level === 1 || depth === 4) return basicForeground(hex);
	if (index !== undefined && index < 256) return ansi;
	if (depth === 8) return foregroundAnsi(parseColor(hex), "256color");
	return undefined;
}

function fgHex(theme: PiRuntimeTheme, color: string): string | undefined {
	return parsePiAnsiToHex(tryPiAccessor(theme, theme.getFgAnsi, color));
}

function bgHex(theme: PiRuntimeTheme, color: string): string | undefined {
	return parsePiAnsiToHex(tryPiAccessor(theme, theme.getBgAnsi, color));
}

/**
 * Build a `GraphTheme` from a live Pi `Theme`-shaped object.
 *
 * Mapping rationale (see `node_modules/@bastani/atomic
 * /src/modes/theme/theme.ts` for the canonical Pi token names):
 *
 *  - Strata: Pi has no first-class panel stratum but exposes
 *    `customMessageBg` / `toolPendingBg` / `selectedBg` as restrained
 *    surfaces. We map them to `backgroundElement` / `backgroundPanel`
 *    / `selection`. `bg` remains a palette seed for color blending;
 *    the graph canvas and node interiors use the terminal default.
 *  - Borders: `borderMuted → borderDim`, `border → border`,
 *    `borderAccent → borderActive`. The `dim` Pi token feeds
 *    `GraphTheme.dim`; `muted` feeds `textMuted`.
 *  - Accents / statuses: direct one-to-one. Pi has no `info` token,
 *    so we fall back to `accent` and finally `MOCHA.sky` to keep
 *    DESIGN.md's status palette intact.
 *
 * Any token that cannot be resolved (host without these accessors,
 * non-truecolor terminal default, or out-of-palette xterm index)
 * falls back through `deriveGraphTheme` to the canonical Catppuccin
 * Mocha defaults — the overlay must always render with a stable
 * palette even if the host theme is mid-load or absent.
 */
export function deriveGraphThemeFromPiTheme(theme: unknown, terminal?: { readonly colorDepth?: number }): GraphTheme {
	if (!theme || typeof theme !== "object") return deriveGraphTheme({});
	const t = theme as PiRuntimeTheme;
	const defaultText = t.name === "light" || t.name === "catppuccin-latte" ? LATTE.text : undefined;
	const accent = fgHex(t, "accent");
	const overrides: GenericTheme = {
		backgroundPanel: bgHex(t, "toolPendingBg") ?? bgHex(t, "customMessageBg"),
		backgroundToolSuccess: bgHex(t, "toolSuccessBg") ?? bgHex(t, "toolPendingBg") ?? bgHex(t, "customMessageBg"),
		backgroundToolError: bgHex(t, "toolErrorBg") ?? bgHex(t, "toolPendingBg") ?? bgHex(t, "customMessageBg"),
		backgroundElement: bgHex(t, "customMessageBg") ?? bgHex(t, "toolPendingBg"),
		selection: bgHex(t, "selectedBg"),
		border: fgHex(t, "border"),
		borderDim: fgHex(t, "borderMuted"),
		borderActive: fgHex(t, "borderAccent"),

		text: fgHex(t, "text") ?? fgHex(t, "customMessageText") ?? defaultText,
		textMuted: fgHex(t, "muted"),
		dim: fgHex(t, "dim"),
		toolTitle: fgHex(t, "toolTitle"),
		toolOutput: fgHex(t, "toolOutput") ?? fgHex(t, "text") ?? fgHex(t, "customMessageText") ?? defaultText,

		accent,
		success: fgHex(t, "success"),
		warning: fgHex(t, "warning"),
		info: accent, // Pi has no `info` token — accent is the closest match.
		error: fgHex(t, "error"),
	};
	// Strip undefined keys so `deriveGraphTheme` falls back to MOCHA for
	// each one individually rather than overwriting good defaults.
	const cleaned: GenericTheme = {};
	for (const [k, v] of Object.entries(overrides)) {
		if (typeof v === "string" && v.length > 0) {
			(cleaned as Record<string, string>)[k] = v;
		}
	}
	const graph = deriveGraphTheme(cleaned);
	if (typeof t.getStyleLevel === "function" && typeof t.getFgAnsi === "function") {
		const styleLevel = t.getStyleLevel.bind(t);
		const localDepth = terminal?.colorDepth ?? process.stdout.getColorDepth?.();
		type Peak = { level: number; depth?: number; ansi?: string; fg?: string };
		const peaks: Partial<Record<"warning" | "info", Peak>> = {};
		graph.stagePaletteFg = (role) => {
			// An isolated component learns its display depth after mounting, before its first host paint.
			const depth = terminal?.colorDepth ?? localDepth;
			const level = styleLevel();
			if (level === 0) return "";
			const ansi = tryPiAccessor(t, t.getFgAnsi, role === "info" ? "accent" : role);
			const cached = peaks[role];
			if (cached && cached.level === level && cached.depth === depth && cached.ansi === ansi) return cached.fg;
			const fg = stagePeak(ansi, graph[role], level, depth);
			peaks[role] = { level, depth, ansi, fg };
			return fg;
		};
	}
	return graph;
}
