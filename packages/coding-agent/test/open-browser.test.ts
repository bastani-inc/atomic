import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn }));

import { openBrowser } from "../src/utils/open-browser.ts";

describe("openBrowser", () => {
	afterEach(() => spawn.mockReset());

	// pi#11592: on WSL, xdg-open starts explorer.exe, which cannot run from a cwd whose \\wsl.localhost\... path
	// exceeds MAX_PATH. The target is a URL, so the launcher needs no working directory.
	it("starts the launcher from the filesystem root, detached, and ignores a launcher that fails to start", () => {
		const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() };
		spawn.mockReturnValue(child);

		openBrowser("https://example.com/login");

		expect(spawn).toHaveBeenCalledTimes(1);
		const [, args, options] = spawn.mock.calls[0]!;
		expect(args).toContain("https://example.com/login");
		expect(options).toMatchObject({ cwd: "/", detached: true, stdio: "ignore" });
		expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
		expect(child.unref).toHaveBeenCalled();
	});
});
