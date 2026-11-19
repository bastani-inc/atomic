import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapSnapshot } from "node:v8";
const root=process.argv[2];
const {MemorySessionStore}=await import(pathToFileURL(join(root,"packages/coding-agent/dist/core/storage/session/memory-session-store.js")));
const {releasedHistoryFiles}=await import(pathToFileURL(join(root,"packages/coding-agent/dist/core/storage/session/released-history-files.js")));
const dir=await mkdtemp(join(tmpdir(),"atomic-chat-record-heap-"));
const store=new MemorySessionStore(undefined,releasedHistoryFiles(dir));
const header=id=>({version:4,id,createdAt:"2026-01-01T00:00:00.000Z",cwd:dir});
async function snapshotStrings(){const buffers=[];for await(const chunk of getHeapSnapshot()) buffers.push(chunk);return JSON.parse(Buffer.concat(buffers).toString()).strings;}
async function populate(id){const {epoch}=await store.create(header(id),[]); const owner={id,epoch};
	for(let i=0;i<32;i++){
		// Use flat strings, so V8's heap snapshot includes their bytes rather than a concatenation node.
		const text=Buffer.from(`${id}-${randomBytes(256).toString("hex")}`).toString();
		await store.chatRecords.append(owner,"",{kind:"line",level:"error",text});
	}
	return owner;
}
try {
	const owner=await populate("releasedDiagnostic");await populate("activeDiagnostic");
	await store.releaseSession(owner.id);await new Promise(r=>setImmediate(r));global.gc();
	const buffers=[];for await(const chunk of getHeapSnapshot()) buffers.push(chunk);
	const {strings}=JSON.parse(Buffer.concat(buffers).toString());
	assert.equal(strings.filter(s=>/^activeDiagnostic-[0-9a-f]{512}$/.test(s)).length,32,"active control is visible in the heap");
	assert.equal(strings.filter(s=>/^releasedDiagnostic-[0-9a-f]{512}$/.test(s)).length,0,"released diagnostic bodies are no longer in the heap");
	assert.equal((await store.chatRecords.read(owner,[""])).length,32,"a new reader can still recover every line");
} finally {await store.close();await rm(dir,{recursive:true,force:true});}

// A release whose files cannot be written keeps the session's previews in memory, never the responses they came from.
const unwritable={async createDirectory(){return {path:"unwritable",async write(){throw Object.assign(new Error("no space"),{code:"ENOSPC"});},
	async read(){throw new Error("never written");},async removeFile(){},async remove(){}};},report(){}};
const kept=new MemorySessionStore(undefined,unwritable);
try {
	const {epoch}=await kept.create(header("unspilled"),[]);const owner={id:"unspilled",epoch};
	const marks=[randomBytes(8).toString("hex"),randomBytes(8).toString("hex")];
	// About 1 MB each and flat, as a provider's response body; dropped by this scope once the records are saved.
	await (async()=>{const [long,sliced]=marks.map(m=>Buffer.from(`${m}-${randomBytes(512*1024).toString("hex")}`).toString());
		await kept.chatRecords.append(owner,"",{kind:"line",level:"error",text:`Error: ${long}`});
		await kept.chatRecords.append(owner,"",{kind:"line",level:"error",text:sliced.slice(0,300)});})();
	await kept.releaseSession(owner.id);assert.equal(kept.spillDegradation()[0]?.code,"spill-write-failed");
	await new Promise(r=>setImmediate(r));global.gc();
	const strings=await snapshotStrings();
	assert.deepEqual(strings.filter(s=>s.length>300&&marks.some(m=>s.startsWith(`${m}-`))).map(s=>s.slice(0,16)),[],"no response body is retained");
	assert.ok(strings.some(s=>s.length===300&&s.startsWith(`${marks[1]}-`)),"the kept preview is visible in the heap");
	const lines=(await kept.chatRecords.read(owner,[""])).map(({record})=>record.text);
	assert.equal(lines.length,2);assert.ok(Buffer.byteLength(lines[0])<=4096&&lines[0].startsWith(`Error: ${marks[0]}-`));assert.equal(lines[1].length,300);
} finally {await kept.close();}
