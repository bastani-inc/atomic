import { reportOwnedWebDiagnostic } from "./diagnostics.js";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { resolve, extname, basename, join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { activityMonitor } from "./activity.js";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.js";
import { createAsyncOwnerState, readWebSearchConfigFile } from "./gemini-web-config.ts";
import { queryGeminiApiWithVideo, getApiKey, API_BASE } from "./gemini-api.js";
import { extractHeadingTitle, type ExtractedContent, type ExtractOptions, type FrameResult } from "./extract.js";
import { readExecError, trimErrorText, mapFfmpegError } from "./utils.js";
import { runBunSubprocess } from "./subprocess.ts";

const UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

const DEFAULT_VIDEO_PROMPT = `Extract the complete content of this video. Include:
1. Video title (infer from content if not explicit), duration
2. A brief summary (2-3 sentences)
3. Full transcript with timestamps
4. Descriptions of any code, terminal commands, diagrams, slides, or UI shown on screen

Format as markdown.`;

const VIDEO_EXTENSIONS: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".mpeg": "video/mpeg",
	".mpg": "video/mpeg",
	".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv",
	".3gp": "video/3gpp",
	".3gpp": "video/3gpp",
};

function shouldRethrow(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.startsWith("Failed to parse ");
}

interface VideoFileInfo {
	absolutePath: string;
	mimeType: string;
	sizeBytes: number;
}

interface VideoConfig {
	enabled: boolean;
	preferredModel: string;
	maxSizeMB: number;
}

function normalizePreferredModel(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeMaxSizeMB(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value > 0 ? value : fallback;
}

const VIDEO_CONFIG_DEFAULTS: VideoConfig = {
	enabled: true,
	preferredModel: "gemini-3-flash-preview",
	maxSizeMB: 50,
};

const loadVideoConfig = createAsyncOwnerState<VideoConfig>(async () => {
	const raw = await readWebSearchConfigFile<{
		video?: { enabled?: boolean; preferredModel?: string; maxSizeMB?: number };
	}>();
	if (!raw) return { ...VIDEO_CONFIG_DEFAULTS };

	const v = raw.video ?? {};
	return {
		enabled: normalizeEnabled(v.enabled, VIDEO_CONFIG_DEFAULTS.enabled),
		preferredModel: normalizePreferredModel(v.preferredModel, VIDEO_CONFIG_DEFAULTS.preferredModel),
		maxSizeMB: normalizeMaxSizeMB(v.maxSizeMB, VIDEO_CONFIG_DEFAULTS.maxSizeMB),
	};
});

/**
 * Resolve a local video path. Returns null for input that is not a local video file; throws when it is
 * one that cannot be analysed because of the `video` settings.
 */
export async function isVideoFile(input: string): Promise<VideoFileInfo | null> {
	const config = await loadVideoConfig();

	const isFilePath = isAbsolute(input) || input.startsWith("./") || input.startsWith("../") || input.startsWith(".\\") || input.startsWith("..\\") || input.startsWith("file://");
	if (!isFilePath) return null;

	let filePath = input;
	if (input.startsWith("file://")) {
		try {
			filePath = fileURLToPath(input);
		} catch {
			return null;
		}
	}

	const ext = extname(filePath).toLowerCase();
	const mimeType = VIDEO_EXTENSIONS[ext];
	if (!mimeType) return null;
	if (!config.enabled) throw new Error(`${input}: video extraction is disabled (video.enabled)`);

	const absolutePath = await resolveFilePath(filePath);
	if (!absolutePath) return null;

	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(absolutePath);
	} catch {
		return null;
	}
	if (!fileStat.isFile()) return null;

	const maxBytes = config.maxSizeMB * 1024 * 1024;
	if (fileStat.size > maxBytes) {
		throw new Error(`${input} exceeds the ${config.maxSizeMB} MB video limit (video.maxSizeMB)`);
	}

	return { absolutePath, mimeType, sizeBytes: fileStat.size };
}

async function resolveFilePath(filePath: string): Promise<string | null> {
	const absolutePath = resolve(filePath);
	try {
		await access(absolutePath);
		return absolutePath;
	} catch {}

	const dir = dirname(absolutePath);
	const base = basename(absolutePath);

	try {
		const entries = await readdir(dir);
		const normalizedBase = normalizeSpaces(base);
		const match = entries.find(f => normalizeSpaces(f) === normalizedBase);
		return match ? join(dir, match) : null;
	} catch {
		return null;
	}
}

function normalizeSpaces(s: string): string {
	return s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");
}

export async function extractVideo(
	info: VideoFileInfo,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent | null> {
	const config = await loadVideoConfig();
	const effectivePrompt = options?.prompt ?? DEFAULT_VIDEO_PROMPT;
	const effectiveModel = options?.model ?? config.preferredModel;
	const displayName = basename(info.absolutePath);
	const activityId = activityMonitor.logStart({ type: "fetch", url: `video:${displayName}` });

	let apiError: string | null = null;
	let result: ExtractedContent | null = null;
	try {
		result = await tryVideoGeminiApi(info, effectivePrompt, effectiveModel, signal);
	} catch (err) {
		apiError = err instanceof Error ? err.message : String(err);
	}
	result ??= await tryVideoGeminiWeb(info, effectivePrompt, effectiveModel, signal);

	if (result) {
		const thumbnail = await extractVideoFrame(info.absolutePath, 1, signal);
		if (!("error" in thumbnail)) {
			result.thumbnail = thumbnail;
		}
		activityMonitor.logComplete(activityId, 200);
		return result;
	}

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	activityMonitor.logError(activityId, apiError ?? "all video extraction paths failed");
	if (apiError) {
		return { url: info.absolutePath, title: "", content: "", error: `Gemini API video analysis failed: ${apiError}` };
	}
	return null;
}

function mapFfprobeError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "ffprobe is not installed. Install ffmpeg which includes ffprobe";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `ffprobe failed: ${snippet}` : "ffprobe failed";
}

export async function extractVideoFrame(filePath: string, seconds: number = 1, signal?: AbortSignal): Promise<FrameResult> {
	try {
		const { stdout } = await runBunSubprocess("ffmpeg", [
			"-ss", String(seconds), "-i", filePath,
			"-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
		], { timeoutMs: 10_000, maxStdoutBytes: 5 * 1024 * 1024, signal });
		if (stdout.length === 0) return { error: "ffmpeg failed: empty output" };
		return { data: stdout.toString("base64"), mimeType: "image/jpeg" };
	} catch (err) {
		return { error: mapFfmpegError(err) };
	}
}

export async function getLocalVideoDuration(filePath: string, signal?: AbortSignal): Promise<number | { error: string }> {
	try {
		const { stdout } = await runBunSubprocess("ffprobe", [
			"-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", filePath,
		], { timeoutMs: 10_000, maxStdoutBytes: 64 * 1024, signal });
		const duration = Number.parseFloat(stdout.toString("utf8").trim());
		if (!Number.isFinite(duration)) return { error: "ffprobe failed: invalid duration output" };
		return duration;
	} catch (err) {
		return { error: mapFfprobeError(err) };
	}
}

async function tryVideoGeminiWeb(
	info: VideoFileInfo,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		const cookies = await isGeminiWebAvailable();
		if (!cookies) return null;
		if (signal?.aborted) return null;

		const text = await queryWithCookies(prompt, cookies, {
			files: [info.absolutePath],
			model,
			signal,
			timeoutMs: 180000,
		});

		return {
			url: info.absolutePath,
			title: extractVideoTitle(text, info.absolutePath),
			content: text,
			error: null,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		return null;
	}
}

async function tryVideoGeminiApi(
	info: VideoFileInfo,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const apiKey = await getApiKey();
	if (!apiKey) return null;
	if (signal?.aborted) return null;

	let fileName: string | null = null;
	try {
		const uploaded = await uploadToFilesApi(info, apiKey, signal);
		fileName = uploaded.name;

		await pollFileState(fileName, apiKey, signal, 120000);

		const text = await queryGeminiApiWithVideo(prompt, uploaded.uri, {
			model,
			mimeType: info.mimeType,
			signal,
			timeoutMs: 120000,
		});

		return {
			url: info.absolutePath,
			title: extractVideoTitle(text, info.absolutePath),
			content: text,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(message.split(apiKey).join("[redacted]"));
	} finally {
		if (fileName) deleteGeminiFile(fileName, apiKey);
	}
}

async function uploadToFilesApi(
	info: VideoFileInfo,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ name: string; uri: string }> {
	const displayName = basename(info.absolutePath);

	const initRes = await fetch(`${UPLOAD_BASE}/files`, {
		method: "POST",
		headers: {
			"x-goog-api-key": apiKey,
			"X-Goog-Upload-Protocol": "resumable",
			"X-Goog-Upload-Command": "start",
			"X-Goog-Upload-Header-Content-Length": String(info.sizeBytes),
			"X-Goog-Upload-Header-Content-Type": info.mimeType,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ file: { display_name: displayName } }),
		signal,
	});

	if (!initRes.ok) {
		const text = await initRes.text();
		throw new Error(`File upload init failed: ${initRes.status} (${text.slice(0, 200)})`);
	}

	const uploadUrl = initRes.headers.get("x-goog-upload-url");
	if (!uploadUrl) throw new Error("No upload URL in response headers");

	const fileData = await readFile(info.absolutePath);
	const uploadRes = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			"Content-Length": String(info.sizeBytes),
			"X-Goog-Upload-Offset": "0",
			"X-Goog-Upload-Command": "upload, finalize",
		},
		body: fileData,
		signal,
	});

	if (!uploadRes.ok) {
		const text = await uploadRes.text();
		throw new Error(`File upload failed: ${uploadRes.status} (${text.slice(0, 200)})`);
	}

	const result = await uploadRes.json() as { file: { name: string; uri: string } };
	return result.file;
}

async function pollFileState(
	fileName: string,
	apiKey: string,
	signal?: AbortSignal,
	timeoutMs: number = 120000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Aborted");

		const res = await fetch(`${API_BASE}/${fileName}?key=${apiKey}`, { signal });
		if (!res.ok) throw new Error(`File state check failed: ${res.status} (${(await res.text()).slice(0, 200)})`);

		const data = await res.json() as { state: string };
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED") throw new Error("File processing failed");

		await new Promise(r => setTimeout(r, 5000));
	}

	throw new Error("File processing timed out");
}

function deleteGeminiFile(fileName: string, apiKey: string): void {
	fetch(`${API_BASE}/${fileName}?key=${apiKey}`, { method: "DELETE" }).catch((err) => {
		const message = err instanceof Error ? err.message : String(err);
		if (!reportOwnedWebDiagnostic()) console.error(`Failed to delete Gemini file ${fileName}: ${message}`);
	});
}

function extractVideoTitle(text: string, filePath: string): string {
	return extractHeadingTitle(text) ?? basename(filePath, extname(filePath));
}
