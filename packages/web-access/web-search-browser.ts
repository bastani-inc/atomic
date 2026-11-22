import { reportOwnedWebDiagnostic } from "./diagnostics.js";
import type { ExtensionAPI } from "@bastani/atomic";
import { findHelperExecutableAsync } from "@bastani/atomic-tui";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { join } from "node:path";
import { runBunSubprocess } from "./subprocess.ts";

export interface GlimpseWindow {
	on(event: "closed", handler: () => void): void;
	on(event: "message", handler: (data: unknown) => void): void;
	on(event: "ready", handler: (info: { screen?: { visibleHeight?: number } }) => void): void;
	close(): void;
	_write(obj: Record<string, unknown>): void;
}

type GlimpseOpen = (html: string, opts: Record<string, unknown>) => GlimpseWindow;

let glimpseOpen: GlimpseOpen | null | undefined;
let glimpseOpenPromise: Promise<GlimpseOpen | null> | undefined;

async function openInBrowser(atomic: ExtensionAPI, url: string): Promise<void> {
	const plat = platform();
	const [name, args]: [string, string[]] = plat === "darwin"
		? ["open", [url]]
		: plat === "win32"
			? ["cmd", ["/c", "start", "", url]]
			: ["xdg-open", [url]];
	// Only from PATH's absolute directories, never from the working directory.
	const file = await findHelperExecutableAsync(name);
	if (file === undefined) throw new Error(`spawn ${name} ENOENT`);
	const result = await atomic.exec(file, args);
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
	}
}

async function findGlimpseMjs(): Promise<string | null> {
	try {
		const req = createRequire(import.meta.url);
		return req.resolve("glimpseui");
	} catch {
		// Optional dependency.
	}
	try {
		const { stdout } = await runBunSubprocess("npm", ["root", "-g"], {
			timeoutMs: 5_000,
			maxStdoutBytes: 64 * 1024,
		});
		const entry = join(stdout.toString("utf8").trim(), "glimpseui", "src", "glimpse.mjs");
		await access(entry);
		return entry;
	} catch {
		// npm may be unavailable.
	}
	return null;
}

async function loadGlimpseOpen(): Promise<GlimpseOpen | null> {
	const resolved = await findGlimpseMjs();
	if (resolved) {
		try {
			const mod = await import(resolved) as { open?: GlimpseOpen };
			return typeof mod.open === "function" ? mod.open : null;
		} catch {}
	}
	return null;
}

async function getGlimpseOpen(): Promise<GlimpseOpen | null> {
	if (glimpseOpen !== undefined) return glimpseOpen;
	glimpseOpenPromise ??= loadGlimpseOpen();
	glimpseOpen = await glimpseOpenPromise;
	return glimpseOpen;
}

function openInGlimpse(open: GlimpseOpen, url: string, title: string): GlimpseWindow {
	const shellHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0; background:#1a1a2e;">
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
	const win = open(shellHTML, {
		width: 800,
		height: 900,
		title,
	});

	let maxHeight = 1200;
	win.on("ready", (info) => {
		const visibleHeight = info?.screen?.visibleHeight;
		if (typeof visibleHeight === "number" && visibleHeight > 0) {
			maxHeight = Math.floor(visibleHeight * 0.85);
		}
	});
	win.on("message", (data) => {
		if (!data || typeof data !== "object") return;
		const msg = data as Record<string, unknown>;
		if (msg.type !== "resize" || typeof msg.height !== "number") return;
		const clamped = Math.max(400, Math.min(Math.round(msg.height), maxHeight));
		win._write({ type: "resize", width: 800, height: clamped });
	});

	return win;
}

export async function openCuratorWindow(
	atomic: ExtensionAPI,
	url: string,
	title: string,
	setGlimpseWindow: (win: GlimpseWindow | null) => void,
	onGlimpseClosed: (win: GlimpseWindow) => void,
): Promise<void> {
	const open = platform() === "darwin" ? await getGlimpseOpen() : null;
	if (open) {
		try {
			const win = openInGlimpse(open, url, title);
			setGlimpseWindow(win);
			win.on("closed", () => onGlimpseClosed(win));
			return;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!reportOwnedWebDiagnostic()) console.error(`Failed to open Glimpse curator window: ${message}`);
			setGlimpseWindow(null);
		}
	}
	await openInBrowser(atomic, url);
}
