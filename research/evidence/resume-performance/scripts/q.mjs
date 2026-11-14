import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const sql = process.argv[3];
for (const r of db.prepare(sql).all()) console.log(JSON.stringify(r));
