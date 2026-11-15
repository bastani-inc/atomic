import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import { stripLeadingCdCommand } from "../src/core/tools/bash-leading-cd.js";

const cwd = resolve("/work/project");
const inheritedCdPath = process.env.CDPATH;

afterEach(() => {
	if (inheritedCdPath === undefined) delete process.env.CDPATH;
	else process.env.CDPATH = inheritedCdPath;
});

function shortcut(command: string): { command: string; cwd: string } | undefined {
	const context = stripLeadingCdCommand(command, cwd);
	return context && { command: context.command, cwd: context.cwd };
}

describe("stripLeadingCdCommand plain-word targets (#4840)", () => {
	it("moves a plain directory word into the cwd (#4840)", () => {
		delete process.env.CDPATH;
		const cases: [string, string, string][] = [
			["cd src && ls", "ls", "src"],
			["  cd\tsrc\t&&\tls", "ls", "src"],
			["cd src;ls", "ls", "src"],
			["cd 'src' && ls", "ls", "src"],
			['cd "src";ls', "ls", "src"],
			["cd src&&\n\n ls -a", "ls -a", "src"],
			["cd a.b_c/d+e@f%g,h:i=j-k && ls", "ls", "a.b_c/d+e@f%g,h:i=j-k"],
			["cd répertoire && ls", "ls", "répertoire"],
			["cd ./src && ls", "ls", "src"],
			["cd ../up && ls", "ls", "../up"],
			["cd v1- && ls | wc -l; echo done &", "ls | wc -l; echo done &", "v1-"],
		];
		for (const [command, rest, dir] of cases) {
			assert.deepEqual(shortcut(command), { command: rest, cwd: resolve(cwd, dir) }, command);
		}
		assert.deepEqual(shortcut("cd /opt/x && ls"), { command: "ls", cwd: resolve("/opt/x") });
	});

	it("expands an unquoted leading ~ to the home directory (#4840)", () => {
		assert.deepEqual(shortcut("cd ~ && ls"), { command: "ls", cwd: homedir() });
		assert.deepEqual(shortcut("cd ~/src && ls"), { command: "ls", cwd: join(homedir(), "src") });
	});

	it("leaves every other cd to bash (#4840)", () => {
		delete process.env.CDPATH;
		const commands = [
			"ls",
			"cdx && ls",
			"ls src && pwd",
			"cd",
			"cd src",
			"cd src &&",
			"cd src; ",
			"cd && ls",
			"cd  ; ls",
			"cd\nsrc && ls",
			"cd src\n&& ls",
			"cd src\nls",
			"cd src 2>/dev/null && ls",
			"cd src>/dev/null && ls",
			"cd src || exit 1; ls",
			"cd src | tee x; ls",
			"cd src|tee x; ls",
			"cd src & ls",
			"cd src &&& ls",
			"cd src ;; ls",
			"cd src && | ls",
			"cd src; ) ls",
			"cd my\\ dir && ls",
			"cd 'my dir' && ls",
			"cd -- src && ls",
			"cd - && ls",
			"cd -P src && ls",
			"cd -src && ls",
			"cd src extra && ls",
			"cd src #note && ls",
			"cd '' && ls",
			"cd 'src && ls",
			'cd "src"x && ls',
			"cd \"src\"'' && ls",
			"cd '$HOME' && ls",
			"cd $HOME && ls",
			'cd "`pwd`" && ls',
			"cd s*c && ls",
			"cd s?c && ls",
			"cd {a,b} && ls",
			"cd a~b && ls",
			"cd ~root && ls",
			"cd '~' && ls",
			'cd "~/src" && ls',
			"cd src\r && ls",
		];
		for (const command of commands) assert.equal(shortcut(command), undefined, command);
	});

	it("leaves a relative cd to bash when CDPATH could redirect it (#4840)", () => {
		process.env.CDPATH = "/elsewhere";
		assert.equal(shortcut("cd src && ls"), undefined);
		assert.equal(shortcut("cd .x && ls"), undefined);
		assert.equal(shortcut("cd src/.. && ls"), undefined);
		assert.deepEqual(shortcut("cd ./src && ls"), { command: "ls", cwd: resolve(cwd, "src") });
		assert.deepEqual(shortcut("cd .. && ls"), { command: "ls", cwd: resolve(cwd, "..") });
		assert.deepEqual(shortcut("cd . && ls"), { command: "ls", cwd: cwd });
		assert.deepEqual(shortcut("cd /opt && ls"), { command: "ls", cwd: resolve("/opt") });
		assert.deepEqual(shortcut("cd ~/src && ls"), { command: "ls", cwd: join(homedir(), "src") });
		process.env.CDPATH = "";
		assert.deepEqual(shortcut("cd src && ls"), { command: "ls", cwd: resolve(cwd, "src") });
	});

	it("hands the shell environment to the stripped command (#4840)", () => {
		process.env.CDPATH = "";
		assert.equal(stripLeadingCdCommand("cd src && ls", cwd)?.env.CDPATH, "");
	});
});
