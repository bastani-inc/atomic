import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ENV_AGENT_DIR,
	ENV_STARTUP_BENCHMARK,
	getAgentDir,
	getAgentDirs,
	getEnvValue,
	getProjectConfigDirs,
	getSettingsPath,
} from "../../config.js";
import { hasProjectTrustInputs, ProjectTrustStore } from "../../core/trust-manager.ts";
import { shouldUseFullscreenTui } from "./fullscreen-environment.ts";

/**
 * Arguments a session started with that change nothing the editor shows before the session is ready, and open no
 * dialog before it: with any other argument the early editor does not start, and startup is as it was.
 */
const ARGUMENTS_WITHOUT_EARLY_EFFECT = new Set(["--offline", "--no-mcp", "--verbose"]);
/** The arguments that decide the folder's trust for this run, so that no trust question can come first. */
const TRUST_ARGUMENTS = new Set(["--approve", "-a", "--no-approve", "-na"]);

/** Settings that change how the editor and the screen around it look or behave before the session is ready. */
const DISPLAY_SETTINGS = [
	"theme",
	"editorPaddingX",
	"autocompleteMaxVisible",
	"showHardwareCursor",
	"terminal",
	"fullscreenScrollbar",
	"fullscreenCopyOnSelect",
	"fullscreenWheelScrollLines",
] as const;

/** Atomic's own themes: a setting that names one is drawn by the early editor exactly as by the session. */
const BUILTIN_THEMES = new Set([
	"dark",
	"light",
	"catppuccin-frappe",
	"catppuccin-latte",
	"catppuccin-macchiato",
	"catppuccin-mocha",
]);

/** What the early editor needs from the configuration, when it may start at all. */
export interface StartupShellPlan {
	readonly agentDir: string;
	/** The theme setting, when it names one of Atomic's own themes; undefined for the default. */
	readonly theme: string | undefined;
}

function readSettingsFile(path: string): Record<string, unknown> | undefined | "unreadable" {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: "unreadable";
	} catch {
		return "unreadable";
	}
}

/**
 * Whether an interactive session started with `args` in `cwd` can show its editor before the session is ready, and
 * with what. Only where nothing the session shows before its editor would come first, and nothing in the settings
 * would draw the editor differently: no argument outside a fixed few, a session on the alternate screen (a terminal
 * on both ends, outside CI, not `TERM=dumb`), no first-run setup, no project trust question,
 * no display setting in a project's settings or in an older agent directory's, and the global theme setting, if any,
 * naming one of Atomic's own themes. Anything else keeps today's startup.
 */
export function planStartupShell(args: readonly string[], cwd: string): StartupShellPlan | undefined {
	if (args.some((arg) => !ARGUMENTS_WITHOUT_EARLY_EFFECT.has(arg) && !TRUST_ARGUMENTS.has(arg))) return undefined;
	// The early editor draws on the alternate screen, which the session itself does not use everywhere.
	if (!shouldUseFullscreenTui(false)) return undefined;
	if (getEnvValue(ENV_STARTUP_BENCHMARK)) return undefined;
	// First run: the setup questions come before the editor.
	if (!getEnvValue(ENV_AGENT_DIR) && !existsSync(getSettingsPath())) return undefined;
	const agentDir = getAgentDir();
	const [primary, ...legacy] = getAgentDirs();
	const global = readSettingsFile(join(primary ?? agentDir, "settings.json"));
	if (global === "unreadable") return undefined;
	for (const dir of [
		...legacy.map((path) => join(path, "settings.json")),
		...getProjectConfigDirs(cwd).map((path) => join(path, "settings.json")),
	]) {
		const other = readSettingsFile(dir);
		if (other === "unreadable") return undefined;
		if (other && DISPLAY_SETTINGS.some((key) => key in other)) return undefined;
	}
	if (global && DISPLAY_SETTINGS.some((key) => key !== "theme" && key in global)) return undefined;
	const theme = global?.theme;
	if (theme !== undefined && !(typeof theme === "string" && BUILTIN_THEMES.has(theme))) return undefined;
	// A folder whose trust is still to be asked asks before the editor.
	const override = args.some((arg) => TRUST_ARGUMENTS.has(arg));
	const defaultProjectTrust = global?.defaultProjectTrust;
	const asks = defaultProjectTrust !== "always" && defaultProjectTrust !== "never";
	if (!override && asks && hasProjectTrustInputs(cwd) && new ProjectTrustStore(agentDir).get(cwd) === null)
		return undefined;
	return { agentDir, theme: theme as string | undefined };
}
