import { promisify } from "node:util";
import { randomUUID } from "crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	type NoParamCallback,
	type PathLike,
	readFileSync,
	readlinkSync,
	realpath as realpathCallback,
	realpathSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { access, chmod, lstat, mkdir, readFile, readlink, rm, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "path";
