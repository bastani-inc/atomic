import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";

let root: string;
let agent: string;
let system: string;
let env: NodeJS.ProcessEnv;
const dist = new URL("../../packages/coding-agent/dist/", import.meta.url).href;
const setup = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const { AGENT: agent, ROOT: root, TMPDIR: system } = process.env;
const load = name => import(new URL(name + '.js', ${JSON.stringify(dist)}));
const config = await load('config');
const old = new Date(Date.now() - 40 * 86400000);
function age(path) {
  if (fs.statSync(path).isDirectory()) for (const n of fs.readdirSync(path)) age(join(path, n));
  fs.utimesSync(path, old, old);
}
`;
function run(script: string): void {
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", setup + script], { env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr || child.stdout);
}
function second(script: string): string {
	return `execFileSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(setup + script)}], {encoding:'utf8'}).trim()`;
}
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-storage-test-"));
	agent = join(root, "agent");
	system = join(root, "system");
	mkdirSync(agent, { mode: 0o700 });
	mkdirSync(system, { mode: 0o700 });
	env = {
		...process.env,
		AGENT: agent,
		ROOT: root,
		HOME: root,
		USERPROFILE: root,
		ATOMIC_CODING_AGENT_DIR: agent,
		TMPDIR: system,
		TEMP: system,
		TMP: system,
		LOCALAPPDATA: join(root, "local"),
	};
	delete env.NODE_DISABLE_COMPILE_CACHE;
	delete env.NODE_COMPILE_CACHE;
	delete env.XDG_RUNTIME_DIR;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each(["ENOSPC", "EACCES"])(
	"keeps every output byte when an allocated agent run later refuses the payload (%s)",
	(code) => {
		run(`const {writeOutputFile} = await load('utils/output-files');
	const first = await writeOutputFile('result','.txt','first'); assert.ok(first.startsWith(agent));
	const privateRoot = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_RUNTIME_DIR = join(root,'runtime'); fs.mkdirSync(privateRoot,{mode:0o700});
	const promises = (await import('node:fs/promises')).default; const original = promises.writeFile;
	const {syncBuiltinESMExports} = await import('node:module');
	const actualPermissions = ${JSON.stringify(code)} === 'EACCES' && process.platform !== 'win32';
	if (actualPermissions) fs.chmodSync(dirname(first),0o500);
	else promises.writeFile = (file,data,...args) => String(file).startsWith(agent) && data.length >= 8192 ? Promise.reject(Object.assign(new Error('write refused'), {code:${JSON.stringify(code)}})) : original(file,data,...args);
	syncBuiltinESMExports();
	try { const data = 'z'.repeat(8192); const saved = await writeOutputFile('result','.txt',data);
	assert.equal(fs.readFileSync(saved,'utf8'),data); assert.ok(saved.toLowerCase().startsWith(privateRoot.toLowerCase()),saved);
	assert.deepEqual(fs.readdirSync(system), []); }
	finally { if(actualPermissions) fs.chmodSync(dirname(first),0o700); }`);
	},
);

test("a refused agent cache tries the private OS runtime root for both bytecode and scratch before system temp", () => {
	run(`const privateRoot = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_RUNTIME_DIR = join(root,'runtime');
	fs.mkdirSync(privateRoot,{mode:0o700});
	if(process.platform === 'win32') fs.writeFileSync(join(agent,'cache'),'not a directory'); else fs.mkdirSync(join(agent,'cache'),{mode:0o500});
	config.useCliRuntimeStorage(); (await load('utils/compile-cache')).enablePersistentCompileCache();
	const cache = (await import('node:module')).getCompileCacheDir();
	assert.ok(cache && cache.toLowerCase().startsWith(privateRoot.toLowerCase()), cache);
	const dir = await config.getRuntimeScratchDir(); assert.ok(dir.toLowerCase().startsWith(privateRoot.toLowerCase()),dir);
	assert.deepEqual(fs.readdirSync(system), []);`);
});

test.skipIf(process.platform === "win32")(
	"compiling first under umask 0002 keeps later CLI spills in the private agent directory",
	() => {
		run(`process.umask(0o002); config.useCliRuntimeStorage();
	(await load('utils/compile-cache')).enablePersistentCompileCache();
	const dir = await (await load('core/tools/session-temp-dir')).getSessionTempDirAsync('rpc');
	fs.writeFileSync(join(dir,'spill'),'data'); assert.ok(dir.startsWith(agent), dir);
	assert.deepEqual(fs.readdirSync(system), []);`);
	},
);

test("Node can read the module cached just before a thirty-day boundary", () => {
	const use = `const {enablePersistentCompileCache} = await load('utils/compile-cache'); enablePersistentCompileCache();
	const mod = await import('node:module'); const dir = mod.getCompileCacheDir(); assert.ok(dir);`;
	run(`Date.now = () => 25919999999; ${use}
	const file = join(root, 'cache-fixture.mjs'); fs.writeFileSync(file, 'export default 42');
	await import((await import('node:url')).pathToFileURL(file)); mod.flushCompileCache();
	assert.ok(fs.readdirSync(dir).length > 0);
	assert.equal(${second(`Date.now = () => 25920000001; ${use}console.log(dir);`)}, dir);`);
});

test("housekeeping does not put new lock files or daily markers in an old system temp tree", () => {
	run(`const {getSessionTempDirAsync} = await load('core/tools/session-temp-dir');
	const session = await getSessionTempDirAsync('existing'); config.useCliRuntimeStorage();
	await (await load('core/tools/session-temp-cleanup')).runSessionTempCleanup({sessionsRoots:[]});
	assert.deepEqual(fs.readdirSync(dirname(session)), ['existing']);`);
});

test("CLI housekeeping still removes stale session spills from before the upgrade", () => {
	run(`const {getSessionTempDirAsync} = await load('core/tools/session-temp-dir');
	const path = join(await getSessionTempDirAsync('legacy-session'), 'spill');
	fs.writeFileSync(path, 'old'); age(dirname(path));
	config.useCliRuntimeStorage(); await (await load('core/tools/session-temp-cleanup')).runSessionTempCleanup({sessionsRoots:[]});
	assert.equal(fs.existsSync(path), false, 'expired legacy spill was left behind');`);
});

test("SDK housekeeping leaves a live process's aged fallback bootstrap readable", () => {
	run(`config.useCliRuntimeStorage();
	fs.writeFileSync(join(agent, 'cache'), 'unavailable'); fs.writeFileSync(process.env.LOCALAPPDATA, 'unavailable');
	const {writeInteractiveEngineBootstrapAsync} = await load('utils/interactive-engine-bootstrap');
	const {path} = await writeInteractiveEngineBootstrapAsync({hostPid:process.pid,guardFile:'guard'});
	assert.ok(path.startsWith(system)); age(system);
	${second(`await (await load('core/tools/session-temp-cleanup')).runSessionTempCleanup({sessionsRoots:[]});`)};
	assert.ok(fs.existsSync(path), 'live bootstrap disappeared');`);
});

test("a second process respects the sweep that protected a live result", () => {
	const sweep = `config.useCliRuntimeStorage(); const { sweepToolResultsRoot } = await load('core/tools/session-temp-cleanup'); const sessions = join(root, 'sessions');`;
	run(`${sweep}
	const dir = join(sessions, 'project', 'tool-results'); fs.mkdirSync(dir, {recursive:true});
	const file = join(dir, 'saved'); fs.writeFileSync(file, 'kept'); age(dir);
	const { acquireProtectedPaths } = await load('core/tools/session-temp-dir');
	const lease = acquireProtectedPaths([dir]);
	assert.equal(await sweepToolResultsRoot(sessions), 'swept');
	assert.equal(${second(`${sweep}console.log(await sweepToolResultsRoot(sessions));`)}, 'throttled');
	assert.equal(fs.readFileSync(file,'utf8'), 'kept'); lease.release();`);
});
