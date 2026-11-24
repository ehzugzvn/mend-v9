// mend — one patch tool for every AI edit format.
// Pure-functional immutable-update design: no in-place mutation of the file
// tree or of line arrays anywhere. Every function takes values in and returns
// new values; the tree is a Map rebuilt on each edit, parsing is done by
// recursive/pure functions, and only the final tree is written out.
// Node 22 standard library only. Implements SPEC.md (version 1).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type FileMap = Map<string, string>;
type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyLine { kind: BodyKind; text: string; }
interface Line { text: string; ctx: boolean; }
interface Failure { code: string; path: string; }
interface UniHunk { a: number; body: BodyLine[]; }
interface UniEdit { kind: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: UniHunk[]; }
interface SrEdit { kind: 'search-replace'; path: string; oldLines: string[]; newLines: string[]; }
interface V4aChunk { anchor: string | null; eof: boolean; body: BodyLine[]; }
interface V4aEdit { kind: 'v4a'; op: 'add' | 'delete' | 'update'; path: string; moveTo: string | null; lines: string[]; chunks: V4aChunk[]; lineNo: number; sawBody: boolean; }
interface JsonEdit { kind: 'json'; op: 'create' | 'str_replace' | 'insert'; path: string; fileText: string; oldStr: string; newStr: string; insertLine: number; }
type Edit = UniEdit | SrEdit | V4aEdit | JsonEdit;
interface ApplyResult { tree: FileMap; failure: Failure | null; move: { old: string; nw: string } | null; }

class ExitError extends Error {
  code: number;
  constructor(code: number, line: string) {
    super(line);
    this.code = code;
  }
}

const fail2 = (line: string): never => { throw new ExitError(2, line); };
const throwParse = (n: number): never => fail2(`error: parse ${n}`);
const failed = (tree: FileMap, code: string, path: string): ApplyResult =>
  ({ tree, failure: { code, path }, move: null });
const okApply = (tree: FileMap, move: { old: string; nw: string } | null = null): ApplyResult =>
  ({ tree, failure: null, move });

const byteCompare = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => { const m = /^[ \t]*/.exec(s); return m === null ? '' : m[0]; };

function splitPatchLines(text: string): string[] {
  const parts = text.split('\n').map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

interface FileLines { lines: string[]; brk: string; ends: boolean; }

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const firstNl = text.indexOf('\n');
  const brk = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const ends = text.endsWith(brk);
  if (ends) parts.pop();
  return { lines: parts, brk, ends };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}

function isSafe(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let good = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j], o[j], tier)) { good = false; break; }
    }
    if (good) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function reindentLine(line: string, fLead: string, pLead: string): string {
  if (line === '' || trimST(line) === '') return line;
  if (line.startsWith(pLead)) return fLead + line.slice(pLead.length);
  return line;
}

// Replace O (at position `at` in `lines`) with N, returning a fresh array.
// Context lines of N are written as the file's own matched lines; at tier 2
// every other line of N is re-indented from O's first-line indent to the
// file's first matched line indent.
function spliceLines(lines: string[], at: number, o: Line[], n: Line[], tier: number): string[] {
  const fLead = o.length > 0 ? leadST(lines[at]) : '';
  const pLead = o.length > 0 ? leadST(o[0].text) : '';
  const oCtxPos: number[] = o.map((ol, idx) => (ol.ctx ? idx : -1)).filter((idx) => idx >= 0);
  let ctxSeen = 0;
  const built = n.map((nl) => {
    if (nl.ctx) {
      const pos = oCtxPos[ctxSeen];
      ctxSeen += 1;
      return lines[at + pos];
    }
    if (tier === 2) return reindentLine(nl.text, fLead, pLead);
    return nl.text;
  });
  return [...lines.slice(0, at), ...built, ...lines.slice(at + o.length)];
}

function withSet(tree: FileMap, path: string, content: string): FileMap {
  const next = new Map(tree);
  next.set(path, content);
  return next;
}

function withDelete(tree: FileMap, path: string): FileMap {
  const next = new Map(tree);
  next.delete(path);
  return next;
}

interface Cli { format: string; check: boolean; strict: boolean; patch: string | null; }

function parseArgs(argv: string[]): Cli {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) fail2('error: usage');
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) fail2('error: usage');
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) fail2('error: usage');
        seenFormat = true;
        format = a.slice('--format='.length);
        if (format !== 'auto' && format !== 'unified' && format !== 'search-replace' && format !== 'v4a' && format !== 'json') fail2('error: usage');
      } else {
        fail2('error: usage');
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) fail2('error: usage');
  return { format: format === null ? 'auto' : format, check, strict, patch: positional.length === 1 ? positional[0] : null };
}

function detectFormat(lines: string[]): string | null {
  const firstNonBlank = lines.find((l) => l.trim() !== '');
  if (firstNonBlank === undefined) return null;
  if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  const c = firstNonBlank.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l) => l.startsWith('diff --git '))) return 'unified';
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (lines[i].startsWith('--- ') && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function readTree(dir: string): FileMap {
  const out: FileMap = new Map();
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      const r = rel === '' ? name : `${rel}/${name}`;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out.set(r, readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

function run(argv: string[]): number {
  const cli = parseArgs(argv);
  let patchText: string;
  if (cli.patch === null || cli.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(cli.patch, 'utf8');
    } catch {
      fail2('error: no-patch');
    }
  }
  const lines = splitPatchLines(patchText);
  const fmt = cli.format === 'auto' ? detectFormat(lines) : cli.format;
  if (fmt === null) fail2('error: format');
  const edits = parsePatch(fmt, lines, patchText);
  if (edits.length === 0) fail2('error: parse 1');
  const before = readTree(process.cwd());
  let tree: FileMap = before;
  const failures: Failure[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const e of edits) {
    const res = applyEdit(tree, e, cli.strict);
    tree = res.tree;
    if (res.failure !== null) failures.push(res.failure);
    else if (res.move !== null) moves.push(res.move);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(`${out.join('\n')}\n`);
    return 1;
  }
  const rOlds = new Set<string>();
  const rNews = new Set<string>();
  const rEntries: { key: string; line: string }[] = [];
  for (const m of moves) {
    if (before.has(m.old) && !tree.has(m.old) && !before.has(m.nw) && tree.has(m.nw)) {
      rOlds.add(m.old);
      rNews.add(m.nw);
      rEntries.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    }
  }
  const entries: { key: string; line: string }[] = [...rEntries];
  for (const p of new Set([...before.keys(), ...tree.keys()])) {
    if (rOlds.has(p) || rNews.has(p)) continue;
    const b = before.get(p);
    const a = tree.get(p);
    if (b === a) continue;
    if (b === undefined) entries.push({ key: p, line: `A ${p}` });
    else if (a === undefined) entries.push({ key: p, line: `D ${p}` });
    else entries.push({ key: p, line: `M ${p}` });
  }
  entries.sort((x, y) => byteCompare(x.key, y.key));
  if (!cli.check) {
    for (const p of new Set([...before.keys(), ...tree.keys()])) {
      const b = before.get(p);
      const a = tree.get(p);
      if (b === a) continue;
      if (a === undefined) {
        if (existsSync(p)) unlinkSync(p);
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, a, 'utf8');
      }
    }
  }
  const outLines = entries.map((e) => e.line);
  outLines.push(`ok: ${entries.length} ${entries.length === 1 ? 'file' : 'files'}`);
  process.stdout.write(`${outLines.join('\n')}\n`);
  return 0;
}

function parsePatch(fmt: string, lines: string[], patchText: string): Edit[] {
  if (fmt === 'unified') return parseUnified(lines);
  if (fmt === 'search-replace') return parseSearchReplace(lines);
  if (fmt === 'v4a') return parseV4a(lines);
  return parseJson(lines, patchText);
}

function applyEdit(tree: FileMap, e: Edit, strict: boolean): ApplyResult {
  if (e.kind === 'unified') return applyUnified(tree, e, strict);
  if (e.kind === 'search-replace') return applySearchReplace(tree, e, strict);
  if (e.kind === 'v4a') return applyV4a(tree, e, strict);
  return applyJson(tree, e);
}

// ---- Unified diffs (§6) ----

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  dgOld: string | null;
  dgNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hasPaths: boolean;
  hunks: UniHunk[];
}

const blankSection = (): UniSection =>
  ({ oldPath: null, newPath: null, dgOld: null, dgNew: null, renFrom: null, renTo: null, newFile: false, delFile: false, hasPaths: false, hunks: [] });

const headerPath = (l: string): string | null => {
  const raw = l.slice(4).split('\t')[0].trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/')) return raw.slice(2);
  if (raw.startsWith('b/')) return raw.slice(2);
  return raw;
};

const parseDiffGit = (l: string): [string, string] | null => {
  const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(l);
  return m === null ? null : [m[1], m[2]];
};

const isDeletionHeader = (s: UniSection): boolean =>
  s.delFile || (s.hasPaths && s.newPath === null);

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let skipDel = false;
  let i = 0;
  const isDiffGit = (l: string): boolean => l.startsWith('diff --git ');
  const isSectionStart = (idx: number): boolean =>
    lines[idx].startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1].startsWith('+++ ');
  while (i < lines.length) {
    const l = lines[i];
    if (skipDel) {
      if (isDiffGit(l) || isSectionStart(i)) {
        skipDel = false;
      } else {
        i += 1;
        continue;
      }
    }
    if (isDiffGit(l)) {
      const dg = parseDiffGit(l);
      if (dg === null) throwParse(i + 1);
      const s = blankSection();
      s.dgOld = dg[0];
      s.dgNew = dg[1];
      sections.push(s);
      cur = s;
      inHeader = true;
      i += 1;
      continue;
    }
    if (isSectionStart(i)) {
      if (cur !== null && inHeader && !cur.hasPaths) {
        cur.oldPath = headerPath(l);
        cur.newPath = headerPath(lines[i + 1]);
        cur.hasPaths = true;
        if (cur.newPath === null) skipDel = true;
        i += 2;
      } else {
        const s = blankSection();
        s.oldPath = headerPath(l);
        s.newPath = headerPath(lines[i + 1]);
        s.hasPaths = true;
        sections.push(s);
        cur = s;
        inHeader = true;
        if (s.newPath === null) skipDel = true;
        i += 2;
      }
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throwParse(i + 1);
      if (isDeletionHeader(cur)) {
        // A deletion's hunks are not read: skip to the next section start.
        inHeader = false;
        i += 1;
        while (i < lines.length) {
          if (isDiffGit(lines[i])) break;
          if (isSectionStart(i)) break;
          i += 1;
        }
        continue;
      }
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throwParse(i + 1);
      const hunk: UniHunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i += 1;
      while (i < lines.length) {
        const bl = lines[i];
        if (isDiffGit(bl)) break;
        if (isSectionStart(i)) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          hunk.body.push({ kind: (bl === '' ? ' ' : bl[0]) as BodyKind, text: bl === '' ? '' : bl.slice(1) });
          i += 1;
        } else {
          break;
        }
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1];
        if (lastB.kind === ' ' && lastB.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throwParse(i + 2);
      if (l.startsWith('rename from ')) cur.renFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) { cur.delFile = true; skipDel = true; }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s): UniEdit => {
    const oldP = s.hasPaths ? s.oldPath : (s.renFrom !== null ? s.renFrom : s.dgOld);
    const newP = s.hasPaths ? s.newPath : (s.renTo !== null ? s.renTo : s.dgNew);
    const isCreate = s.newFile || oldP === null;
    const isDelete = s.delFile || newP === null;
    return { kind: 'unified', oldPath: oldP, newPath: newP, isCreate, isDelete, hunks: s.hunks };
  });
}

const hunkLines = (body: BodyLine[]): { o: Line[]; n: Line[] } => {
  const o: Line[] = [];
  const n: Line[] = [];
  for (const b of body) {
    if (b.kind === ' ') { o.push({ text: b.text, ctx: true }); n.push({ text: b.text, ctx: true }); }
    else if (b.kind === '-') o.push({ text: b.text, ctx: false });
    else if (b.kind === '+') n.push({ text: b.text, ctx: false });
  }
  return { o, n };
};

// True when a `\` line immediately follows the hunk's last context or `+` line.
const backslashAfterLast = (body: BodyLine[]): boolean => {
  let last = -1;
  body.forEach((b, idx) => { if (b.kind === ' ' || b.kind === '+') last = idx; });
  if (last === -1) return false;
  return last + 1 < body.length && body[last + 1].kind === '\\';
};

function applyUnified(tree: FileMap, e: UniEdit, strict: boolean): ApplyResult {
  if (e.isDelete && !e.isCreate) {
    const oldP = e.oldPath;
    if (oldP === null) return failed(tree, 'unsafe', '');
    if (!isSafe(oldP)) return failed(tree, 'unsafe', oldP);
    if (!tree.has(oldP)) return failed(tree, 'missing', oldP);
    return okApply(withDelete(tree, oldP));
  }
  if (e.isCreate) {
    const newP = e.newPath;
    if (newP === null) return failed(tree, 'unsafe', '');
    if (!isSafe(newP)) return failed(tree, 'unsafe', newP);
    if (tree.has(newP)) return failed(tree, 'exists', newP);
    const plusLines: string[] = [];
    e.hunks.forEach((h) => h.body.forEach((b) => { if (b.kind === '+') plusLines.push(b.text); }));
    let lastPlus: { h: number; j: number } | null = null;
    e.hunks.forEach((h, hi) => h.body.forEach((b, j) => { if (b.kind === '+') lastPlus = { h: hi, j }; }));
    let ends = true;
    if (lastPlus !== null) {
      const body = e.hunks[lastPlus.h].body;
      if (lastPlus.j + 1 < body.length && body[lastPlus.j + 1].kind === '\\') ends = false;
    }
    const content = plusLines.length === 0 ? '' : plusLines.join('\n') + (ends ? '\n' : '');
    return okApply(withSet(tree, newP, content));
  }
  const oldP = e.oldPath;
  const newP = e.newPath;
  if (oldP === null || newP === null) return failed(tree, 'unsafe', '');
  if (!isSafe(oldP)) return failed(tree, 'unsafe', oldP);
  if (!isSafe(newP)) return failed(tree, 'unsafe', newP);
  if (!tree.has(oldP)) return failed(tree, 'missing', oldP);
  const isMove = oldP !== newP;
  if (isMove && tree.has(newP)) return failed(tree, 'exists', newP);
  let cur = splitFile(tree.get(oldP) as string);
  let d = 0;
  for (const h of e.hunks) {
    const { o, n } = hunkLines(h.body);
    const oTexts = o.map((x) => x.text);
    if (o.length === 0) {
      const pos = Math.min(h.a + d, cur.lines.length);
      const nextLines = [...cur.lines.slice(0, pos), ...n.map((x) => x.text), ...cur.lines.slice(pos)];
      let ends = cur.ends;
      if (pos === cur.lines.length) ends = !backslashAfterLast(h.body);
      cur = { lines: nextLines, brk: cur.brk, ends };
      d += n.length;
    } else {
      const found = findTier(cur.lines, oTexts, strict);
      if (found === null) return failed(tree, 'no-match', oldP);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const reachesEnd = best + o.length === cur.lines.length;
      const nextLines = spliceLines(cur.lines, best, o, n, found.tier);
      let ends = cur.ends;
      if (reachesEnd) ends = !backslashAfterLast(h.body);
      cur = { lines: nextLines, brk: cur.brk, ends };
      d += n.length - o.length;
    }
  }
  const content = joinFile(cur);
  if (isMove) {
    const next = withDelete(tree, oldP);
    return okApply(withSet(next, newP, content), { old: oldP, nw: newP });
  }
  return okApply(withSet(tree, oldP, content));
}

// ---- SEARCH/REPLACE blocks (§7) ----

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: SrEdit[] = [];
  let prevReplaceEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevReplaceEnd; j -= 1) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throwParse(searchIdx + 1);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '=======') { eq = j; break; }
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throwParse(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep === -1) throwParse(searchIdx + 1);
    edits.push({ kind: 'search-replace', path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function applySearchReplace(tree: FileMap, e: SrEdit, strict: boolean): ApplyResult {
  if (!isSafe(e.path)) return failed(tree, 'unsafe', e.path);
  if (e.oldLines.length === 0) {
    if (tree.has(e.path)) return failed(tree, 'exists', e.path);
    const content = e.newLines.length === 0 ? '' : `${e.newLines.join('\n')}\n`;
    return okApply(withSet(tree, e.path, content));
  }
  if (!tree.has(e.path)) return failed(tree, 'missing', e.path);
  const cur = splitFile(tree.get(e.path) as string);
  const found = findTier(cur.lines, e.oldLines, strict);
  if (found === null) return failed(tree, 'no-match', e.path);
  if (found.occ.length > 1) return failed(tree, 'ambiguous', e.path);
  const o: Line[] = e.oldLines.map((t) => ({ text: t, ctx: false }));
  const n: Line[] = e.newLines.map((t) => ({ text: t, ctx: false }));
  const nextLines = spliceLines(cur.lines, found.occ[0], o, n, found.tier);
  return okApply(withSet(tree, e.path, joinFile({ lines: nextLines, brk: cur.brk, ends: cur.ends })));
}

// ---- V4A patches (§8) ----

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k += 1) {
    if (lines[k].trim() !== '') { first = k; break; }
  }
  if (first === -1) throwParse(1);
  if (lines[first].trim() !== '*** Begin Patch') throwParse(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (lines[k].trim() !== '') { last = k; break; }
  }
  if (lines[last].trim() !== '*** End Patch') throwParse(lines.length + 1);
  const edits: V4aEdit[] = [];
  let cur: V4aEdit | null = null;
  let curChunk: V4aChunk | null = null;
  let eofClosed = false;
  const finishSection = (): void => {
    if (cur === null) return;
    if (cur.op === 'update') {
      const chunks = cur.chunks;
      if (chunks.length > 0) {
        const lastCh = chunks[chunks.length - 1];
        while (lastCh.body.length > 0) {
          const b = lastCh.body[lastCh.body.length - 1];
          if (b.kind === ' ' && b.text === '') lastCh.body.pop();
          else break;
        }
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throwParse(cur.lineNo);
    }
    if (cur.op === 'add') {
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    }
    edits.push(cur);
    cur = null;
    curChunk = null;
    eofClosed = false;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD)) {
      finishSection();
      const op = l.startsWith(V4A_ADD) ? 'add' : (l.startsWith(V4A_DEL) ? 'delete' : 'update');
      const prefix = op === 'add' ? V4A_ADD : (op === 'delete' ? V4A_DEL : V4A_UPD);
      cur = { kind: 'v4a', op, path: l.slice(prefix.length).trim(), moveTo: null, lines: [], chunks: [], lineNo: i + 1, sawBody: false };
      curChunk = null;
      eofClosed = false;
      i += 1;
      continue;
    }
    if (cur === null) {
      if (l.trim() === '') { i += 1; continue; }
      throwParse(i + 1);
    }
    if (cur.op === 'add') {
      if (l.startsWith('+')) { cur.lines.push(l.slice(1)); i += 1; continue; }
      if (l === '') { cur.lines.push(''); i += 1; continue; }
      throwParse(i + 1);
    }
    if (cur.op === 'delete') {
      if (l.trim() === '') { i += 1; continue; }
      throwParse(i + 1);
    }
    if (l.startsWith(V4A_MOVE)) {
      if (cur.chunks.length > 0 || curChunk !== null || cur.sawBody) throwParse(i + 1);
      cur.moveTo = l.slice(V4A_MOVE.length).trim();
      cur.sawBody = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
      cur.chunks.push(curChunk);
      eofClosed = false;
      cur.sawBody = true;
      i += 1;
      continue;
    }
    if (l === '*** End of File') {
      if (curChunk === null) throwParse(i + 1);
      curChunk.eof = true;
      eofClosed = true;
      curChunk = null;
      i += 1;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (eofClosed) throwParse(i + 1);
      if (curChunk === null) {
        if (cur.chunks.length > 0) throwParse(i + 1);
        curChunk = { anchor: null, eof: false, body: [] };
        cur.chunks.push(curChunk);
      }
      curChunk.body.push({ kind: (l === '' ? ' ' : l[0]) as BodyKind, text: l === '' ? '' : l.slice(1) });
      cur.sawBody = true;
      i += 1;
      continue;
    }
    throwParse(i + 1);
  }
  finishSection();
  return edits;
}

function applyV4a(tree: FileMap, e: V4aEdit, strict: boolean): ApplyResult {
  if (!isSafe(e.path)) return failed(tree, 'unsafe', e.path);
  if (e.moveTo !== null && !isSafe(e.moveTo)) return failed(tree, 'unsafe', e.moveTo);
  if (e.op === 'add') {
    if (tree.has(e.path)) return failed(tree, 'exists', e.path);
    const content = e.lines.length === 0 ? '' : `${e.lines.join('\n')}\n`;
    return okApply(withSet(tree, e.path, content));
  }
  if (e.op === 'delete') {
    if (!tree.has(e.path)) return failed(tree, 'missing', e.path);
    return okApply(withDelete(tree, e.path));
  }
  if (!tree.has(e.path)) return failed(tree, 'missing', e.path);
  if (e.moveTo !== null && tree.has(e.moveTo)) return failed(tree, 'exists', e.moveTo);
  let cur = splitFile(tree.get(e.path) as string);
  let cursor = 0;
  for (const ch of e.chunks) {
    if (ch.anchor !== null) {
      let foundIdx = -1;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top && foundIdx === -1; t += 1) {
        for (let k = cursor; k < cur.lines.length; k += 1) {
          if (lineEq(cur.lines[k], ch.anchor as string, t)) { foundIdx = k; break; }
        }
      }
      if (foundIdx === -1) return failed(tree, 'no-match', e.path);
      cursor = foundIdx + 1;
    }
    const { o, n } = hunkLines(ch.body);
    const oTexts = o.map((x) => x.text);
    if (o.length === 0) {
      const pos = ch.eof ? cur.lines.length : cursor;
      const nextLines = [...cur.lines.slice(0, pos), ...n.map((x) => x.text), ...cur.lines.slice(pos)];
      cur = { lines: nextLines, brk: cur.brk, ends: cur.ends };
      cursor = pos + n.length;
    } else {
      let found: { tier: number; at: number } | null = null;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top && found === null; t += 1) {
        const occ = occurrences(cur.lines, oTexts, t)
          .filter((p) => p >= cursor && (!ch.eof || p + o.length === cur.lines.length));
        if (occ.length > 0) found = { tier: t, at: occ[0] };
      }
      if (found === null) return failed(tree, 'no-match', e.path);
      const nextLines = spliceLines(cur.lines, found.at, o, n, found.tier);
      cur = { lines: nextLines, brk: cur.brk, ends: cur.ends };
      cursor = found.at + n.length;
    }
  }
  const content = joinFile(cur);
  if (e.moveTo !== null) {
    const next = withDelete(tree, e.path);
    return okApply(withSet(next, e.moveTo, content), { old: e.path, nw: e.moveTo });
  }
  return okApply(withSet(tree, e.path, content));
}

// ---- JSON edits (§9) ----

function validateJsonEdit(v: unknown, lineNo: number): JsonEdit {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throwParse(lineNo);
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') throwParse(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throwParse(lineNo);
    return { kind: 'json', op: 'create', path: o.path, fileText: o.file_text, oldStr: '', newStr: '', insertLine: 0 };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throwParse(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throwParse(lineNo);
    return { kind: 'json', op: 'str_replace', path: o.path, fileText: '', oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '', insertLine: 0 };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throwParse(lineNo);
    if (typeof o.new_str !== 'string') throwParse(lineNo);
    return { kind: 'json', op: 'insert', path: o.path, fileText: '', oldStr: '', newStr: o.new_str, insertLine: o.insert_line };
  }
  throwParse(lineNo);
}

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k += 1) {
    if (lines[k].trim() !== '') { first = k; break; }
  }
  if (first === -1) throwParse(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throwParse(first + 1);
    }
    if (!Array.isArray(arr)) throwParse(first + 1);
    for (const item of arr) edits.push(validateJsonEdit(item, first + 1));
    return edits;
  }
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k];
    if (l.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throwParse(k + 1);
    }
    edits.push(validateJsonEdit(obj, k + 1));
  }
  return edits;
}

const countOccurrences = (text: string, needle: string): number => {
  let count = 0;
  let idx = 0;
  for (;;) {
    const p = text.indexOf(needle, idx);
    if (p === -1) return count;
    count += 1;
    idx = p + 1;
  }
};

function applyJson(tree: FileMap, e: JsonEdit): ApplyResult {
  if (!isSafe(e.path)) return failed(tree, 'unsafe', e.path);
  if (e.op === 'create') {
    if (tree.has(e.path)) return failed(tree, 'exists', e.path);
    return okApply(withSet(tree, e.path, e.fileText));
  }
  if (!tree.has(e.path)) return failed(tree, 'missing', e.path);
  const raw = tree.get(e.path) as string;
  if (e.op === 'str_replace') {
    const fl = splitFile(raw);
    const norm = fl.brk === '\r\n';
    const text = norm ? raw.replace(/\r\n/g, '\n') : raw;
    const oldS = norm ? e.oldStr.replace(/\r\n/g, '\n') : e.oldStr;
    const newS = norm ? e.newStr.replace(/\r\n/g, '\n') : e.newStr;
    const count = countOccurrences(text, oldS);
    if (count === 0) return failed(tree, 'no-match', e.path);
    if (count > 1) return failed(tree, 'ambiguous', e.path);
    const at = text.indexOf(oldS);
    let result = text.slice(0, at) + newS + text.slice(at + oldS.length);
    if (norm) result = result.replace(/\n/g, '\r\n');
    return okApply(withSet(tree, e.path, result));
  }
  const fl = splitFile(raw);
  if (e.insertLine < 0 || e.insertLine > fl.lines.length) return failed(tree, 'no-match', e.path);
  const ins = e.newStr === '' ? [] : splitPatchLines(e.newStr);
  const nextLines = [...fl.lines.slice(0, e.insertLine), ...ins, ...fl.lines.slice(e.insertLine)];
  return okApply(withSet(tree, e.path, joinFile({ lines: nextLines, brk: fl.brk, ends: fl.ends })));
}

// ---- Entry point: trial hand-over or CLI ----

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ExitError) {
      process.stdout.write(`${err.message}\n`);
      process.exitCode = err.code;
    } else {
      throw err;
    }
  }
}
