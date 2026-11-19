import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { readFile, unlink } from "fs/promises";
import { join } from "path";
import { getRuntimeScratchDir } from "../config.js";

import { createChildProcessEnvironment } from "./child-process.ts";
import { clipboard } from "./clipboard-native.ts";
import { loadPhoton } from "./photon.ts";
import { windowsPowerShellEnvironment } from "./windows-powershell.ts";
import { isWSL } from "./wsl.ts";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * Convert unsupported image formats to PNG using Photon.
 * Returns null if conversion is unavailable or fails.
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

function runCommand(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: Buffer; ok: boolean }> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
	const env = options?.env ? createChildProcessEnvironment(undefined, options.env) : createChildProcessEnvironment();

	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				encoding: "buffer",
				timeout: timeoutMs,
				maxBuffer: maxBufferBytes,
				// Clipboard tools ignore the cwd, and WSL cannot start powershell.exe from a deep \\wsl.localhost\... path (pi#11592).
				cwd: "/",
				env,
			},
			(error, stdout) => {
				if (error) {
					resolve({ ok: false, stdout: Buffer.alloc(0) });
					return;
				}
				const buffer = Buffer.isBuffer(stdout)
					? stdout
					: Buffer.from(stdout ?? "", typeof stdout === "string" ? "utf-8" : undefined);
				resolve({ ok: true, stdout: buffer });
			},
		);
	});
}

async function readClipboardImageViaWlPaste(): Promise<ClipboardImage | null> {
	const list = await runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = await runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) {
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
async function readClipboardImageViaPowerShell(): Promise<ClipboardImage | null> {
	const tmpFile = join(await getRuntimeScratchDir(), `pi-wsl-clip-${randomUUID()}.png`);

	try {
		const winPathResult = await runCommand("wslpath", ["-w", tmpFile], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
		if (!winPathResult.ok) {
			return null;
		}

		const winPath = winPathResult.stdout.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = await runCommand("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
			env: windowsPowerShellEnvironment(),
		});
		if (!result.ok) {
			return null;
		}

		const output = result.stdout.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		const bytes = await readFile(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			await unlink(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

async function readClipboardImageViaXclip(): Promise<ClipboardImage | null> {
	const targets = await runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	if (!targets.ok) return null;

	const candidateTypes = targets.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	const preferred = selectPreferredImageMimeType(candidateTypes);
	if (!preferred) return null;

	const data = await runCommand("xclip", ["-selection", "clipboard", "-t", preferred, "-o"]);
	if (!data.ok || data.stdout.length === 0) return null;
	return { bytes: data.stdout, mimeType: baseMimeType(preferred) };
}

async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null> {
	if (!clipboard?.hasImage()) {
		return null;
	}

	const imageData = await clipboard.getImageBinary();
	if (!imageData || imageData.length === 0) {
		return null;
	}

	const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
	return { bytes, mimeType: "image/png" };
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null = null;

	if (platform === "linux") {
		const wsl = await isWSL(env);
		const wayland = isWaylandSession(env);

		if (wayland || wsl) {
			image = (await readClipboardImageViaWlPaste()) ?? (await readClipboardImageViaXclip());
		}

		if (!image && wsl) {
			image = await readClipboardImageViaPowerShell();
		}

		if (!image && !wayland) {
			image = await readClipboardImageViaNativeClipboard();
			if (!image) {
				image = await readClipboardImageViaXclip();
			}
		}
	} else {
		image = await readClipboardImageViaNativeClipboard();
	}

	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g., BMP from WSLg) to PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}
