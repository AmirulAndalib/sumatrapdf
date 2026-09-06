// List minidumps from the crash server, download missing dumps, run cdb.
//
//   bun cmd/crashes.ts              list (oldest first); analyze missing
//   bun cmd/crashes.ts --local      same, against http://127.0.0.1:9321
//   bun cmd/crashes.ts <id>         download dump + pdb, run !analyze
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(join(import.meta.dir, ".."));
const CACHE_DIR = join(ROOT, ".work", "crashes");
const PROD_SERVER = "https://www.sumatrapdfreader.org";
const LOCAL_SERVER = "http://127.0.0.1:9321";

type DumpRow = {
  id: string;
  version: string;
  date: string;
  size: number;
  ip: string;
};

function usage(): void {
  console.log(`Usage:
  bun cmd/crashes.ts [--local]                 list; download+analyze dumps we don't have yet
  bun cmd/crashes.ts [--local] <id>            download dump, pdb, run cdb (!analyze -v; ~*kb)
  bun cmd/crashes.ts -reanalyze [--local] [id] force cdb again (dump/pdb stay cached)
  bun cmd/crashes.ts --server <url> ...        override server base URL`);
}

function parseArgs(argv: string[]): { server: string; id: string; reanalyze: boolean } {
  let server = PROD_SERVER;
  let id = "";
  let reanalyze = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    }
    if (a === "--local") {
      server = LOCAL_SERVER;
      continue;
    }
    if (a === "-reanalyze" || a === "-re-analyze" || a === "--reanalyze" || a === "--re-analyze") {
      reanalyze = true;
      continue;
    }
    if (a === "--server") {
      const url = argv[++i];
      if (!url) {
        throw new Error("--server needs a URL");
      }
      server = url.replace(/\/$/, "");
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`unknown flag ${a}`);
    }
    if (id) {
      throw new Error("only one minidump id");
    }
    id = a;
  }
  return { server, id, reanalyze };
}

function parseList(text: string): DumpRow[] {
  const rows: DumpRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    const parts = s.split(",");
    if (parts.length !== 5) {
      throw new Error(`bad minidump list line: ${s}`);
    }
    rows.push({
      id: parts[0],
      version: parts[1],
      date: parts[2],
      size: parseInt(parts[3], 10),
      ip: parts[4],
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function fmtSize(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function dumpDir(id: string): string {
  return join(CACHE_DIR, id);
}

function dumpPath(id: string): string {
  return join(dumpDir(id), `${id}.dmp`);
}

function analyzePath(id: string): string {
  return join(dumpDir(id), "analyze.txt");
}

function relAnalyze(id: string): string {
  return relative(ROOT, analyzePath(id)).replaceAll("\\", "/");
}

function isAnalyzed(id: string): boolean {
  const p = analyzePath(id);
  if (!existsSync(p)) {
    return false;
  }
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

function printRows(rows: DumpRow[]): void {
  if (rows.length === 0) {
    console.log("no minidumps");
    return;
  }
  const cols = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    date: Math.max(4, ...rows.map((r) => r.date.length)),
    size: Math.max(4, ...rows.map((r) => fmtSize(r.size).length)),
    ip: Math.max(2, ...rows.map((r) => r.ip.length)),
  };
  const hdr = `${"id".padEnd(cols.id)}  ${"version".padEnd(cols.version)}  ${"date".padEnd(cols.date)}  ${"size".padStart(cols.size)}  ${"ip".padEnd(cols.ip)}`;
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(cols.id)}  ${r.version.padEnd(cols.version)}  ${r.date.padEnd(cols.date)}  ${fmtSize(r.size).padStart(cols.size)}  ${r.ip.padEnd(cols.ip)}`,
    );
    if (isAnalyzed(r.id)) {
      console.log(relAnalyze(r.id));
    }
  }
  console.log(`${rows.length} minidump${rows.length === 1 ? "" : "s"}`);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return await res.text();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function findCdb(): string {
  const env = process.env.PATH ?? "";
  for (const dir of env.split(";")) {
    if (!dir) {
      continue;
    }
    const p = join(dir, "cdb.exe");
    if (existsSync(p)) {
      return p;
    }
  }
  const kits = [
    String.raw`C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe`,
    String.raw`C:\Program Files\Windows Kits\10\Debuggers\x64\cdb.exe`,
  ];
  for (const p of kits) {
    if (existsSync(p)) {
      return p;
    }
  }
  const where = spawnSync("where.exe", ["cdb.exe"], { encoding: "utf8" });
  if (where.status === 0) {
    const first = where.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (first && existsSync(first)) {
      return first;
    }
  }
  return "";
}

function archSuffix(version: string): string {
  if (/arm64/i.test(version)) {
    return "arm64";
  }
  if (/\b32-bit\b/i.test(version)) {
    return "32";
  }
  return "64";
}

function prerelVer(version: string): string {
  const v = version.trim();
  if (/^\d+$/.test(v)) {
    return v;
  }
  const m = /^(\d+\.\d+)\.(\d+)/.exec(v);
  return m ? m[2] : "";
}

function symbolCacheKey(version: string): string {
  const ver = prerelVer(version);
  const arch = archSuffix(version);
  if (ver) {
    return arch === "64" ? ver : `${ver}-${arch}`;
  }
  return version.trim().replace(/[^\w.-]+/g, "_") || "unknown";
}

function pdbUrlForVersion(version: string): string {
  const v = version.trim();
  const arch = archSuffix(v);
  const suff = arch === "64" ? "-64.pdb.lzsa" : arch === "arm64" ? "-arm64.pdb.lzsa" : "-32.pdb.lzsa";
  const relSuff = arch === "32" ? ".pdb.lzsa" : suff;
  const prerel = prerelVer(v);
  if (prerel) {
    return `${PROD_SERVER}/dl/prerel/${prerel}/SumatraPDF-prerel${suff}`;
  }
  const rel = /^(\d+\.\d+)/.exec(v);
  if (rel) {
    return `${PROD_SERVER}/dl/rel/${rel[1]}/SumatraPDF-${rel[1]}${relSuff}`;
  }
  return "";
}

function readU32(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

function readCString(buf: Uint8Array, off: number): string {
  let end = off;
  while (end < buf.length && buf[end] !== 0) {
    end++;
  }
  return new TextDecoder("utf-8").decode(buf.subarray(off, end));
}

function x86BcjDecode(data: Uint8Array): void {
  const kMaskToAllowedStatus = [1, 1, 1, 0, 1, 0, 0, 0];
  const kMaskToBitNumber = [0, 1, 2, 2, 3, 3, 3, 3];
  const testMs = (b: number) => b === 0 || b === 0xff;
  const size = data.length;
  if (size < 5) {
    return;
  }
  let bufferPos = 0;
  let prevPosT = -1;
  let prevMask = 0;
  let ip = 5;
  for (;;) {
    let p = bufferPos;
    const limit = size - 4;
    while (p < limit && (data[p] & 0xfe) !== 0xe8) {
      p++;
    }
    bufferPos = p;
    if (p >= limit) {
      break;
    }
    prevPosT = bufferPos - prevPosT;
    if (prevPosT > 3) {
      prevMask = 0;
    } else {
      prevMask = (prevMask << (prevPosT - 1)) & 0x7;
      if (prevMask !== 0) {
        const b = data[p + 4 - kMaskToBitNumber[prevMask]];
        if (!kMaskToAllowedStatus[prevMask] || testMs(b)) {
          prevPosT = bufferPos;
          prevMask = ((prevMask << 1) & 0x7) | 1;
          bufferPos++;
          continue;
        }
      }
    }
    prevPosT = bufferPos;
    if (testMs(data[p + 4])) {
      let src = (data[p + 4] << 24) | (data[p + 3] << 16) | (data[p + 2] << 8) | data[p + 1];
      src = src >>> 0;
      let dest = 0;
      for (;;) {
        dest = (src - (ip + bufferPos)) >>> 0;
        if (prevMask === 0) {
          break;
        }
        const index = kMaskToBitNumber[prevMask] * 8;
        const b = (dest >>> (24 - index)) & 0xff;
        if (!testMs(b)) {
          break;
        }
        src = (dest ^ ((1 << (32 - index)) - 1)) >>> 0;
      }
      data[p + 4] = ~((((dest >>> 24) & 1) - 1) >>> 0) & 0xff;
      data[p + 3] = (dest >>> 16) & 0xff;
      data[p + 2] = (dest >>> 8) & 0xff;
      data[p + 1] = dest & 0xff;
      bufferPos += 5;
    } else {
      prevMask = ((prevMask << 1) & 0x7) | 1;
      bufferPos++;
    }
  }
}

function pythonLzma(): string[] | null {
  for (const cmd of [["py", "-3"], ["python"], ["python3"]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "-c", "import lzma"], { encoding: "utf8" });
    if (r.status === 0) {
      return cmd;
    }
  }
  return null;
}

function lzmaDecompress(propsAndPayload: Uint8Array, unpackedSize: number): Uint8Array {
  const py = pythonLzma();
  if (!py) {
    throw new Error("python with lzma is required to unpack .pdb.lzsa");
  }
  const script = `
import lzma, sys
n = int(sys.argv[1])
d = sys.stdin.buffer.read()
# LzSA stores no unpacked size in the LZMA header; -1 is FORMAT_ALONE "unknown"
header = d[:5] + (0xFFFFFFFFFFFFFFFF).to_bytes(8, "little")
out = lzma.decompress(header + d[5:], format=lzma.FORMAT_ALONE)
if len(out) != n:
    raise SystemExit(f"lzma size {len(out)} want {n}")
sys.stdout.buffer.write(out)
`;
  const r = spawnSync(py[0], [...py.slice(1), "-c", script, String(unpackedSize)], {
    input: Buffer.from(propsAndPayload),
    encoding: "buffer",
    maxBuffer: unpackedSize + 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`lzma decompress failed: ${r.stderr?.toString() || r.status}`);
  }
  return new Uint8Array(r.stdout);
}

function extractLzsaPdb(archive: Uint8Array, destDir: string): void {
  if (archive.length < 8) {
    throw new Error("lzsa too small");
  }
  const magic = readU32(archive, 0);
  if (magic !== 0x41537a4c) {
    throw new Error("not an LzSA archive");
  }
  const nFiles = readU32(archive, 4);
  type FileEnt = { name: string; compressedSize: number; uncompressedSize: number; dataOff: number };
  const files: FileEnt[] = [];
  let off = 8;
  for (let i = 0; i < nFiles; i++) {
    const hdrSize = readU32(archive, off);
    const compressedSize = readU32(archive, off + 4);
    const uncompressedSize = readU32(archive, off + 8);
    const name = readCString(archive, off + 24);
    files.push({ name, compressedSize, uncompressedSize, dataOff: 0 });
    off += hdrSize;
  }
  off += 4; // header crc
  for (const f of files) {
    f.dataOff = off;
    off += f.compressedSize;
  }
  mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const chunk = archive.subarray(f.dataOff, f.dataOff + f.compressedSize);
    if (chunk.length < 1) {
      throw new Error(`empty lzsa file ${f.name}`);
    }
    let raw: Uint8Array;
    const filter = chunk[0];
    if (filter === 0xff) {
      raw = chunk.subarray(1);
    } else {
      raw = lzmaDecompress(chunk.subarray(1), f.uncompressedSize);
      if (filter === 1) {
        x86BcjDecode(raw);
      }
    }
    writeFileSync(join(destDir, f.name), raw);
  }
}

function hasSumatraPdbs(dir: string): boolean {
  return existsSync(join(dir, "SumatraPDF.pdb")) && existsSync(join(dir, "libsumatrapdf.pdb"));
}

function localDbgSymDir(version: string): string {
  if (!/\(dbg\)/i.test(version)) {
    return "";
  }
  for (const d of [join(ROOT, "out", "dbg64"), join(ROOT, "out", "dbg64_asan")]) {
    if (hasSumatraPdbs(d)) {
      return d;
    }
  }
  return "";
}

async function ensureSymbols(row: DumpRow): Promise<string> {
  const local = localDbgSymDir(row.version);
  if (local) {
    return local;
  }
  const dir = join(CACHE_DIR, "symbols", symbolCacheKey(row.version));
  if (hasSumatraPdbs(dir)) {
    return dir;
  }
  const url = pdbUrlForVersion(row.version);
  if (!url) {
    throw new Error(`no pdb source for version '${row.version}'`);
  }
  mkdirSync(dir, { recursive: true });
  const lzsaPath = join(dir, "pdb.lzsa");
  if (!existsSync(lzsaPath) || statSync(lzsaPath).size === 0) {
    console.log(`pdb: downloading ${url}`);
    writeFileSync(lzsaPath, await fetchBytes(url));
  }
  extractLzsaPdb(readFileSync(lzsaPath), dir);
  if (!hasSumatraPdbs(dir)) {
    throw new Error(`pdb lzsa missing SumatraPDF.pdb or libsumatrapdf.pdb (${url})`);
  }
  return dir;
}

const MARK_CRASHED = "---CRASHED-STACK---";
const MARK_ANALYZE = "---ANALYZE---";
const MARK_THREADS = "---THREADS---";

function markerIndex(text: string, marker: string): number {
  const re = new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const m = re.exec(text);
  return m ? m.index : -1;
}

function sectionBetween(text: string, start: string, end: string | null): string {
  const i = markerIndex(text, start);
  if (i < 0) {
    return "";
  }
  const from = i + start.length;
  const j = end ? markerIndex(text.slice(from), end) : -1;
  const to = j < 0 ? text.length : from + j;
  return text.slice(from, to).replace(/^\r?\n/, "");
}

function extractStackText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("STACK_TEXT:"));
  if (start < 0) {
    return "";
  }
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (/^[A-Z][A-Z0-9_ ]+:/.test(l) && !l.startsWith("STACK_TEXT:")) {
      break;
    }
    end++;
  }
  return lines.slice(start, end).join("\n").trim();
}

function trimQuit(s: string): string {
  const i = s.search(/^quit:\s*$/m);
  return i < 0 ? s.trim() : s.slice(0, i).trim();
}

function rewriteAnalyzeLog(raw: string): string {
  const crashed = trimQuit(sectionBetween(raw, MARK_CRASHED, MARK_ANALYZE)) || extractStackText(raw);
  const analyze = trimQuit(sectionBetween(raw, MARK_ANALYZE, MARK_THREADS)) || raw.trim();
  const threads = trimQuit(sectionBetween(raw, MARK_THREADS, null));
  const parts: string[] = [];
  if (crashed) {
    parts.push("=== crashed thread ===", crashed, "");
  }
  if (threads) {
    parts.push("=== all threads (~*kb) ===", threads, "");
  }
  parts.push("=== !analyze -v ===", analyze, "");
  return parts.join("\n");
}

const CDB_CMD = `.echo ${MARK_CRASHED}; .ecxr; kb; .echo ${MARK_ANALYZE}; !analyze -v; .echo ${MARK_THREADS}; ~*kb; qq`;

async function analyze(server: string, row: DumpRow, reanalyze: boolean): Promise<void> {
  if (!reanalyze && isAnalyzed(row.id)) {
    return;
  }
  const dir = dumpDir(row.id);
  mkdirSync(dir, { recursive: true });
  const dmpPath = dumpPath(row.id);
  if (!existsSync(dmpPath)) {
    const url = `${server}/minidump/${row.id}`;
    console.log(`dump: downloading ${url}`);
    writeFileSync(dmpPath, await fetchBytes(url));
  }
  const outPath = analyzePath(row.id);
  if (reanalyze && existsSync(outPath)) {
    unlinkSync(outPath);
  }
  const symDir = await ensureSymbols(row);
  const cdb = findCdb();
  if (!cdb) {
    console.log(`dump: ${dmpPath}`);
    console.log(`pdb:  ${symDir}`);
    console.log("cdb.exe not found; install Windows Debugging Tools to run !analyze");
    return;
  }
  const nt = process.env._NT_SYMBOL_PATH?.trim();
  const symParts = [`cache*${join(CACHE_DIR, "sym")}`, symDir];
  if (nt) {
    symParts.push(nt);
  }
  const symPath = symParts.join(";");
  console.log(`cdb: ${cdb}`);
  console.log(`pdb: ${relative(ROOT, symDir).replaceAll("\\", "/")}`);
  const r = spawnSync(cdb, ["-z", dmpPath, "-y", symPath, "-lines", "-logo", outPath, "-c", CDB_CMD], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    writeFileSync(outPath, `${r.stdout || ""}\n${r.stderr || ""}`);
  }
  if (existsSync(outPath)) {
    writeFileSync(outPath, rewriteAnalyzeLog(readFileSync(outPath, "utf8")));
  }
}

async function ensureAnalyzed(server: string, row: DumpRow, reanalyze: boolean): Promise<void> {
  if (!reanalyze && isAnalyzed(row.id)) {
    return;
  }
  await analyze(server, row, reanalyze);
}

async function main(): Promise<void> {
  const { server, id, reanalyze } = parseArgs(process.argv.slice(2));
  const list = parseList(await fetchText(`${server}/minidumps.txt`));
  if (id) {
    const row = list.find((r) => r.id === id);
    if (!row) {
      throw new Error(`minidump '${id}' not in ${server}/minidumps.txt`);
    }
    await ensureAnalyzed(server, row, reanalyze);
    console.log(relAnalyze(row.id));
    return;
  }
  for (const row of list) {
    try {
      await ensureAnalyzed(server, row, reanalyze);
    } catch (e) {
      console.error(`${row.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  printRows(list);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
