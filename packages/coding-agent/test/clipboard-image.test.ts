import { writeFileSync } from "fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

// The simulated platform's programs are the mocked child processes, so every helper is found under its own name.
vi.mock("../src/utils/helper-command.ts", () => ({
	findHelperExecutable: (name: string) => name,
	findHelperExecutableAsync: async (name: string) => name,
	helperLaunch: (name: string) => ({ file: name }),
	helperLaunchAsync: async (name: string) => ({ file: name }),
	missingHelperOptions: () => ({}),
}));

type ExecFileCallback = (error: Error | null, stdout: Buffer, stderr: Buffer) => void;

const mocks = vi.hoisted(() => {
	return {
		execFile: vi.fn<(command: string, args: string[], options: unknown, callback: ExecFileCallback) => void>(),
		clipboard: {
			hasImage: vi.fn<() => boolean>(),
			getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
		},
	};
});

vi.mock("child_process", () => {
	return {
		execFile: mocks.execFile,
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

function execOk(callback: ExecFileCallback, stdout: Buffer): void {
	callback(null, stdout, Buffer.alloc(0));
}

function execError(callback: ExecFileCallback, error: Error): void {
	callback(error, Buffer.alloc(0), Buffer.alloc(0));
}

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.execFile.mockReset();
		mocks.clipboard.hasImage.mockReset();
		mocks.clipboard.getImageBinary.mockReset();
	});

	test("Wayland: uses wl-paste and never calls clipboard", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		mocks.execFile.mockImplementation((command, args, _options, callback) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				execOk(callback, Buffer.from("text/plain\nimage/png\n", "utf-8"));
				return;
			}
			if (command === "wl-paste" && args[0] === "--type") {
				execOk(callback, Buffer.from([1, 2, 3]));
				return;
			}
			throw new Error(`Unexpected execFile call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3]);
	});

	test("Wayland: falls back to xclip when wl-paste is missing", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		const enoent = new Error("spawn ENOENT");
		(enoent as { code?: string }).code = "ENOENT";

		mocks.execFile.mockImplementation((command, args, _options, callback) => {
			if (command === "wl-paste") {
				execError(callback, enoent);
				return;
			}

			if (command === "xclip" && args.includes("TARGETS")) {
				execOk(callback, Buffer.from("image/png\n", "utf-8"));
				return;
			}

			if (command === "xclip" && args.includes("image/png")) {
				execOk(callback, Buffer.from([9, 8]));
				return;
			}

			execOk(callback, Buffer.alloc(0));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([9, 8]);
	});

	test("WSL: starts Windows PowerShell without the parent's PSModulePath", async () => {
		const saved = process.env.PSModulePath;
		process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules";
		try {
			let powershellEnv: NodeJS.ProcessEnv | undefined;
			mocks.execFile.mockImplementation((command, args, options, callback) => {
				if (command === "wl-paste" || command === "xclip") {
					execOk(callback, Buffer.alloc(0));
					return;
				}
				if (command === "wslpath") {
					execOk(callback, Buffer.from("C:\\clip.png\n", "utf-8"));
					return;
				}
				if (command === "powershell.exe") {
					powershellEnv = (options as { env?: NodeJS.ProcessEnv }).env;
					execOk(callback, Buffer.from("empty\n", "utf-8"));
					return;
				}
				throw new Error(`Unexpected execFile call: ${command} ${args.join(" ")}`);
			});

			const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
			await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
			expect(powershellEnv).toBeDefined();
			expect(Object.keys(powershellEnv ?? {}).filter((key) => key.toLowerCase() === "psmodulepath")).toEqual([]);
		} finally {
			if (saved === undefined) delete process.env.PSModulePath;
			else process.env.PSModulePath = saved;
		}
	});

	test("WSL: passes PowerShell path directly instead of through a custom env var", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called before PowerShell on WSL");
		});

		let tmpFile: string | undefined;
		const cwds: Record<string, unknown> = {};
		mocks.execFile.mockImplementation((command, args, options, callback) => {
			cwds[command] = (options as { cwd?: string }).cwd;
			if (command === "wl-paste" || command === "xclip") {
				execOk(callback, Buffer.alloc(0));
				return;
			}

			if (command === "wslpath") {
				tmpFile = args[1];
				execOk(callback, Buffer.from("C:\\Users\\O'Hare\\clip.png\n", "utf-8"));
				return;
			}

			if (command === "powershell.exe") {
				const spawnOptions = options as { env?: NodeJS.ProcessEnv };
				expect(spawnOptions.env?.PI_WSL_CLIPBOARD_IMAGE_PATH).toBeUndefined();
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) {
					throw new Error("wslpath should be called before powershell.exe");
				}
				writeFileSync(tmpFile, Buffer.from([4, 5, 6]));
				execOk(callback, Buffer.from("ok\n", "utf-8"));
				return;
			}

			throw new Error(`Unexpected execFile call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([4, 5, 6]);
		// pi#11592: WSL cannot start powershell.exe from a cwd whose \\wsl.localhost\... path exceeds MAX_PATH.
		expect(cwds).toMatchObject({ wslpath: "/", "powershell.exe": "/" });
	});

	test("Non-Wayland: uses clipboard", async () => {
		mocks.execFile.mockImplementation(() => {
			throw new Error("execFile should not be called for non-Wayland sessions");
		});

		mocks.clipboard.hasImage.mockReturnValue(true);
		mocks.clipboard.getImageBinary.mockResolvedValue(new Uint8Array([7]));

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([7]);
	});

	test("Non-Wayland: falls back to xclip when native clipboard has no image", async () => {
		mocks.clipboard.hasImage.mockReturnValue(false);
		mocks.execFile.mockImplementation((command, args, _options, callback) => {
			if (command === "xclip" && args.includes("TARGETS")) {
				execOk(callback, Buffer.from("image/png\n", "utf-8"));
				return;
			}
			if (command === "xclip" && args.includes("image/png")) {
				execOk(callback, Buffer.from([6, 7]));
				return;
			}
			throw new Error(`Unexpected execFile call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([6, 7]);
	});

	test("X11 does not probe image types when TARGETS fails (pi#9786)", async () => {
		mocks.clipboard.hasImage.mockReturnValue(false);
		mocks.execFile.mockImplementation((command, args, _options, callback) => {
			if (command === "xclip" && args.includes("TARGETS")) {
				execError(callback, new Error("no targets"));
				return;
			}
			execOk(callback, Buffer.from("hello"));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "linux", env: {} })).toBeNull();
		expect(mocks.execFile.mock.calls.map(([, args]) => args[3])).toEqual(["TARGETS"]);
	});

	test("X11 does not probe unadvertised image types", async () => {
		mocks.clipboard.hasImage.mockReturnValue(false);
		mocks.execFile.mockImplementation((command, args, _options, callback) => {
			if (command === "xclip" && args.includes("TARGETS")) {
				execOk(callback, Buffer.from("image/png\n"));
				return;
			}
			if (command === "xclip" && args.includes("image/png")) {
				execError(callback, new Error("owner refused"));
				return;
			}
			execOk(callback, Buffer.from("hello"));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "linux", env: {} })).toBeNull();
		expect(mocks.execFile.mock.calls.map(([, args]) => args[3])).toEqual(["TARGETS", "image/png"]);
	});
});
