import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "vitest";
import { bunExecutable, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const modules = new URL("../../packages/coding-agent/dist/core/worktree-snapshot/", import.meta.url);
const clock = new URL("shared-clock.js", modules).href;
const pool = new URL("pool.js", modules).href;
let root: string;
beforeEach(() => {
	root = makeTempDirectory("pool-clock-");
});
afterEach(() => removeTempDirectory(root));

// A fresh process matters: another Atomic operation may already have loaded the bindings in the test runner.
test.each(["Node", "Bun"])("a cold %s lock does not load the native package (#5605)", async (runtime) => {
	const script = `
		import { createRequire } from 'node:module';
		const require = createRequire(import.meta.url);
		const loaded = () => Object.keys(require.cache).some(p => p.includes('atomic_natives.') && p.endsWith('.node'));
		await import(${JSON.stringify(pool)});
		const { lockShared } = await import(${JSON.stringify(clock)});
		if (loaded()) throw Error('expected a cold pool');
		const release = await lockShared(process.env.LOCK_FILE, { realpath: false });
		try { if (loaded()) throw Error('first lock loaded the native package'); } finally { await release(); }
	`;
	const file = join(root, "slot");
	writeFileSync(file, "");
	await run(runtime === "Node" ? process.execPath : bunExecutable(), ["--input-type=module", "-e", script], {
		env: { ...process.env, LOCK_FILE: file },
	});
});

test("a cold clock does not need a separate Windows module to acquire a lock (#5605)", async () => {
	const script = `
		import { registerHooks } from 'node:module';
		registerHooks({load(url, context, next) {
			if (url.endsWith('/windows-temporary.js')) throw Error('unexpected Windows helper read');
			return next(url, context);
		}});
		const { lockShared } = await import(${JSON.stringify(clock)});
		const release = await lockShared(process.env.LOCK_FILE, { realpath: false });
		await release();
	`;
	await run(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, LOCK_FILE: join(root, "slot") },
	});
});

test("a Bun clock reading does not ask a registry for missing optional bindings (#5674)", async () => {
	const calls: string[] = [];
	const server = createServer((request, response) => {
		calls.push(request.url ?? "");
		response.writeHead(404).end("{}");
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const registry = `http://127.0.0.1:${address.port}/`;
		const cache = join(root, "empty-cache");
		mkdirSync(cache);
		mkdirSync(join(root, "node_modules"));
		symlinkSync(
			dirname(require.resolve("proper-lockfile/package.json")),
			join(root, "node_modules", "proper-lockfile"),
			"junction",
		);
		copyFileSync(new URL("shared-clock.js", modules), join(root, "shared-clock.js"));
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		writeFileSync(
			join(root, "bunfig.toml"),
			`[install]\nregistry = "${registry}"\n[install.scopes]\n"@bastani" = "${registry}"\n`,
		);
		mkdirSync(join(root, "store"));
		writeFileSync(
			join(root, "run.mjs"),
			`import { sharedClockOffset } from './shared-clock.js'; const now = Date.now.bind(Date); Date.now = () => now()+180000; console.log(await sharedClockOffset('store'));`,
		);
		const { stdout } = await run(bunExecutable(), ["--config=bunfig.toml", "run.mjs"], {
			cwd: root,
			env: {
				...process.env,
				BUN_INSTALL_CACHE_DIR: cache,
				BUN_CONFIG_REGISTRY: registry,
				npm_config_registry: registry,
				NODE_PATH: "",
				NO_PROXY: "127.0.0.1",
			},
		});
		assert.deepEqual(calls, []);
		assert.ok(Math.abs(Number(stdout.trim()) + 180_000) < 10_000, stdout);
		assert.deepEqual(readdirSync(join(root, "store")), []);
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
	}
});

test.runIf(process.platform === "win32").each(["Node", "Bun"])(
	"a held slot has the same write permissions as a mode-0600 file under %s (#5636)",
	async (runtime) => {
		const script = `
			import assert from 'node:assert/strict';
			import { closeSync, openSync, statSync, writeFileSync } from 'node:fs';
			import { createRequire } from 'node:module';
			import { join } from 'node:path';
			createRequire(import.meta.url)('@bastani/atomic-natives');
			const {admitPooledWorktree, releaseRestoredWorktree, repositoryIdOf} = await import(${JSON.stringify(pool)});
			const storeDir = process.env.POOL_STORE, remotes = ['https://example.com/acme/repo.git'];
			const state = {snapshotId:null, head:'a'.repeat(40), tree:'b'.repeat(40)};
			const permissions = path => {
				let error;
				try { closeSync(openSync(path, 'r+')); } catch (e) { error = e.code; }
				return [statSync(path).mode & 0o777, error];
			};
			process.umask(0o222);
			const control = join(storeDir, 'control');
			writeFileSync(control, '', {mode:0o600});
			const lease = await admitPooledWorktree({storeDir,remotes,lastState:state,envHash:'env'}, {kind:'session',id:'owner'});
			try { assert.deepEqual(permissions(join(storeDir,'pool',repositoryIdOf(remotes),'0.json')), permissions(control)); }
			finally { await releaseRestoredWorktree(lease,state); }
		`;
		await run(runtime === "Node" ? process.execPath : bunExecutable(), ["--input-type=module", "-e", script], {
			env: { ...process.env, POOL_STORE: root },
		});
	},
);

test.runIf(process.platform === "win32")(
	"Bun can admit and release a slot when existing files cannot be reopened for writing (#5636)",
	async () => {
		const script = `
		import assert from 'node:assert/strict';
		import { execFileSync } from 'node:child_process';
		import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
		import { createRequire } from 'node:module';
		import { join } from 'node:path';
		createRequire(import.meta.url)('@bastani/atomic-natives');
		const {admitPooledWorktree, releaseRestoredWorktree, repositoryIdOf} = await import(${JSON.stringify(pool)});
		const remotes = ['https://example.com/acme/repo.git'];
		const storeDir = process.env.POOL_STORE;
		const dir = join(storeDir, 'pool', repositoryIdOf(remotes));
		mkdirSync(dir, {recursive:true});
		execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(`
			$ErrorActionPreference = 'Stop'
			$acl = Get-Acl -LiteralPath $env:POOL_DIR
			$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
			$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'WriteData','ObjectInherit','InheritOnly','Deny')
			$acl.AddAccessRule($rule)
			Set-Acl -LiteralPath $env:POOL_DIR -AclObject $acl
		`)}], {env:{...process.env, POOL_DIR:dir}});
		const control = join(dir, 'control');
		writeFileSync(control, 'created');
		assert.throws(() => writeFileSync(control, 'reopened'), {code:'EPERM'});
		const state = {snapshotId:null, head:'a'.repeat(40), tree:'b'.repeat(40)};
		const owner = {kind:'session', id:'slot-owner'};
		const lease = await admitPooledWorktree({storeDir, remotes, lastState:state, envHash:'env'}, owner);
		assert.equal(lease.slot, 0);
		assert.deepEqual(JSON.parse(readFileSync(join(dir,'0.json'),'utf8')).holder, owner);
		assert.equal(await releaseRestoredWorktree(lease,state), true);
	`;
		await run(bunExecutable(), ["-e", script], { env: { ...process.env, POOL_STORE: root } });
	},
);

test.runIf(process.platform === "win32")(
	"old-probe cleanup uses the same fractional mtime as stat (#5605)",
	async () => {
		const probe = join(root, ".clock-0123456789abcdef.probe");
		writeFileSync(probe, "abandoned");
		await run(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[IO.File]::SetLastWriteTimeUtc($env:PROBE, [DateTime]::FromFileTimeUtc(134395436000000003L))",
			],
			{ env: { ...process.env, PROBE: probe } },
		);
		const before = 1_795_070_000_000.0005;
		assert.ok(statSync(probe).mtimeMs < before);
		await require("@bastani/atomic-natives").removeWindowsFileOlderThan(probe, before);
		assert.deepEqual(readdirSync(root), []);
	},
);

test.runIf(process.platform === "win32")(
	"an old probe is unlisted while another handle shares deletion (#5605)",
	async () => {
		const file = join(root, ".clock-0123456789abcdef.probe");
		writeFileSync(file, "abandoned");
		const old = new Date(Date.now() - 24 * 60 * 60_000);
		utimesSync(file, old, old);
		const readClock = join(root, "read.mjs");
		writeFileSync(
			readClock,
			`import { createRequire } from 'node:module'; createRequire(${JSON.stringify(import.meta.url)})('@bastani/atomic-natives'); const {sharedClockOffset} = await import(${JSON.stringify(clock)}); await sharedClockOffset(process.env.PROBE_DIRECTORY);`,
		);
		await run(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`
		$ErrorActionPreference = 'Stop'
		Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class SharedProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
'@
		# DELETE | FILE_READ_ATTRIBUTES, with FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE.
		$handle = [SharedProbe]::CreateFileW($env:PROBE_FILE,0x10080,7,[IntPtr]::Zero,3,128,[IntPtr]::Zero)
		if ($handle.IsInvalid) { throw 'could not open the abandoned probe' }
		try {
			& $env:NODE_EXE $env:READ_CLOCK
			if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
			if ((Get-ChildItem -Force -LiteralPath $env:PROBE_DIRECTORY).Name -contains '.clock-0123456789abcdef.probe') { throw 'abandoned probe still listed' }
		} finally { $handle.Dispose() }
	`,
			],
			{
				env: {
					...process.env,
					PROBE_FILE: file,
					PROBE_DIRECTORY: root,
					NODE_EXE: process.execPath,
					READ_CLOCK: readClock,
				},
			},
		);
		assert.ok(!readdirSync(root).includes(".clock-0123456789abcdef.probe"));
	},
);
