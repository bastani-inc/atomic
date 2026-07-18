import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: index-raw.ts RUN_ROOT");
const raw = join(root, "raw");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
const directories: string[] = ["."];
const files: string[] = [];
const walk = (directory: string, prefix = ""): void => {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(path).isDirectory()) {
      directories.push(relative);
      walk(path, relative);
    } else files.push(relative);
  }
};
walk(raw);
const fileRecords = files.map(name => {
  const path = join(raw, name);
  return { name, size: statSync(path).size, mode: mode(path), sha256: sha256(path) };
});
const directoryRecords = directories.sort().map(name => {
  const path = name === "." ? raw : join(raw, name);
  return { name, mode: mode(path) };
});
const badFileModes = fileRecords.filter(record => record.mode !== "0600");
const badDirectoryModes = directoryRecords.filter(record => record.mode !== "0700");
if (badFileModes.length || badDirectoryModes.length) throw new Error("private raw permissions are not 0600/0700");
const index = {
  summary: {
    rawRoot: "../raw",
    fileCount: fileRecords.length,
    directoryCount: directoryRecords.length,
    totalFileBytes: fileRecords.reduce((sum, record) => sum + record.size, 0),
    requiredFileMode: "0600",
    requiredDirectoryMode: "0700",
    badFileModeCount: badFileModes.length,
    badDirectoryModeCount: badDirectoryModes.length,
  },
  directories: directoryRecords,
  files: fileRecords,
};
const output = join(root, "public/raw-artifacts.json");
writeFileSync(output, JSON.stringify(index, null, 2) + "\n", { mode: 0o644 });
chmodSync(output, 0o644);
