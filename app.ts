// The forge: a standalone GitHub-compatible git host in one Node process.
//
// Surfaces, all over one shared in-memory store:
//   - git smart HTTP (protocol v2 ls-refs/fetch, v0 receive-pack) under /<owner>/<repo>.git
//   - the REST v3 resources under /api/v3
//   - GraphQL v4 at /api/graphql
//   - an MCP endpoint (JSON-RPC) at /mcp
//
// State lives in memory only: the trial hands the process a fresh, empty forge and every
// surface seeds what it needs through the public routes. main.ts owns the lifecycle; this
// file is the server.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0000000000000000000000000000000000000000';

/**
 * The one user the bearer token names. The suite's scenario is fixed-seeded (wire.ts), so the
 * token owner's identity is a constant of the deployment, like GitHub's authenticated user.
 */
const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

const AGENT = 'forge/1.0.0';

// ---------------------------------------------------------------------------------------------
// Data model

type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

interface GitObject {
  type: ObjectType;
  data: Buffer;
}

interface LabelRec {
  name: string;
  color: string;
}

interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  comments: Map<number, CommentRec[]>;
  nextNumber: number;
  nextCommentId: number;
  commitCache: Map<string, ParsedCommit>;
  seq: number;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextSeq = 1;
let nextRequestId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

function createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdAt: new Date().toISOString(),
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    commitCache: new Map(),
    seq: nextSeq++,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

// ---------------------------------------------------------------------------------------------
// Git object primitives

function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\u0000`);
  hash.update(data);
  return hash.digest('hex');
}

function storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(Number(match[3]) * 1000).toISOString() };
}

function parseCommit(repo: Repo, oid: string): ParsedCommit | null {
  const cached = repo.commitCache.get(oid);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const text = object.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = { name: '', email: '', date: new Date(0).toISOString() };
  let committer = author;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  const parsed: ParsedCommit = {
    tree,
    parents,
    message,
    authorName: author.name,
    authorEmail: author.email,
    authorDate: author.date,
    committerName: committer.name,
    committerEmail: committer.email,
    committerDate: committer.date,
  };
  repo.commitCache.set(oid, parsed);
  return parsed;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, directories as if their name ended in '/'. */
function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeEntryCompare);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> blob entry. */
function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees for a flat path -> blob-oid map; returns the root tree oid. */
function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

/** The files (path -> blob oid) of a commit's root tree. */
function commitFiles(repo: Repo, commitOid: string): Map<string, string> {
  const commit = parseCommit(repo, commitOid);
  const files = new Map<string, string>();
  if (commit === null) return files;
  for (const [path, entry] of flattenTree(repo, commit.tree)) files.set(path, entry.oid);
  return files;
}

/** Create and store a commit object authored by the forge's user; the message is kept verbatim. */
function makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const stamp = Math.floor(Date.now() / 1000);
  const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`, `committer ${identity}`, '', message);
  return storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** The commit an annotated tag object ultimately names, or null. */
function tagTarget(repo: Repo, tagOid: string): string | null {
  let current = tagOid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

/** Resolve a ref name, branch name or oid to a commit oid, or null. */
function resolveCommit(repo: Repo, ref: string): string | null {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    if (object === undefined) return null;
    if (object.type === 'commit') return ref;
    if (object.type === 'tag') return tagTarget(repo, ref);
    return null;
  }
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') return tagTarget(repo, oid);
      return oid;
    }
  }
  return null;
}

/** Every object reachable from `tips`; commits in `stopAt` are included but their parents are not walked. */
function closureObjects(repo: Repo, tips: readonly string[], stopAt?: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(repo, oid);
      if (commit !== null) {
        stack.push(commit.tree);
        if (stopAt === undefined || !stopAt.has(oid)) stack.push(...commit.parents);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return out;
}

/** The nearest common ancestor of two commits, or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestors = new Map<string, number>();
  let frontier = [a];
  let distance = 0;
  ancestors.set(a, 0);
  while (frontier.length > 0) {
    const next: string[] = [];
    distance += 1;
    for (const oid of frontier) {
      const commit = parseCommit(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!ancestors.has(parent)) {
          ancestors.set(parent, distance);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  if (ancestors.has(b)) return b;
  frontier = [b];
  const seen = new Set<string>([b]);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestors.has(oid)) return oid;
      const commit = parseCommit(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** Whether `ancestor` is reachable from `descendant` through parent links. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = parseCommit(repo, oid);
    if (commit !== null) stack.push(...commit.parents);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktReader {
  /** The next packet: a Buffer payload, 'flush', 'delim', or null at end of input. */
  next(): Buffer | 'flush' | 'delim' | null;
  /** The unconsumed remainder (the pack bytes after a receive-pack command list). */
  rest(): Buffer;
}

function pktReader(buffer: Buffer): PktReader {
  let offset = 0;
  return {
    next() {
      if (offset + 4 > buffer.length) return null;
      const header = buffer.toString('ascii', offset, offset + 4);
      if (!/^[0-9a-f]{4}$/.test(header)) return null;
      const length = parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        return 'flush';
      }
      if (length === 1) {
        offset += 4;
        return 'delim';
      }
      if (length < 4 || offset + length > buffer.length) return null;
      const payload = buffer.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    rest() {
      return buffer.subarray(offset);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Packfiles

const TYPE_CODES: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: readonly string[] = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs-delta', 'ref-delta'];

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A complete v2 packfile carrying `objects` in the order given, with its SHA-1 trailer. */
function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The exact byte length of the zlib stream starting at `offset`: the smallest slice that inflates. */
function inflatedLength(buffer: Buffer, offset: number): number {
  let lo = 1;
  let hi = buffer.length - offset;
  const attempt = (length: number): boolean => {
    try {
      inflateSync(buffer.subarray(offset, offset + length));
      return true;
    } catch {
      return false;
    }
  };
  if (!attempt(hi)) throw new Error('a pack object does not inflate');
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (attempt(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------
// A deflate stream walker: the exact compressed length of one zlib stream, found by decoding its
// block structure (Huffman symbols counted, never emitted), so a pack object costs one inflate
// instead of a binary search of them. Any irregularity throws and the caller falls back to the
// search above; the pack trailer checksum remains the final word either way.

const DEFLATE_LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const DEFLATE_LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DEFLATE_DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEFLATE_DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const DEFLATE_CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  count: number[];
  symbol: number[];
}

/** Build a canonical Huffman decoding table from code lengths (puff.c's construct). */
function huffmanBuild(lengths: readonly number[]): Huffman {
  const count = new Array<number>(16).fill(0);
  for (const length of lengths) count[length] = (count[length] as number) + 1;
  if (count[0] === lengths.length) return { count, symbol: [] };
  let left = 1;
  for (let len = 1; len <= 15; len += 1) {
    left <<= 1;
    left -= count[len] as number;
    if (left < 0) throw new Error('over-subscribed huffman code');
  }
  const offs = new Array<number>(16).fill(0);
  for (let len = 1; len <= 14; len += 1) offs[len + 1] = (offs[len] as number) + (count[len] as number);
  const symbol = new Array<number>(lengths.length);
  lengths.forEach((length, sym) => {
    if (length !== 0) {
      symbol[offs[length] as number] = sym;
      offs[length] = (offs[length] as number) + 1;
    }
  });
  return { count, symbol };
}

class BitReader {
  private bytePos: number;
  private bitPos = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer, offset: number) {
    this.buffer = buffer;
    this.bytePos = offset;
  }

  bits(need: number): number {
    let value = 0;
    let shift = 0;
    let remaining = need;
    while (remaining > 0) {
      if (this.bytePos >= this.buffer.length) throw new Error('deflate stream overruns the pack');
      const byte = this.buffer[this.bytePos] as number;
      const take = Math.min(remaining, 8 - this.bitPos);
      value |= ((byte >> this.bitPos) & ((1 << take) - 1)) << shift;
      shift += take;
      remaining -= take;
      this.bitPos += take;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos += 1;
      }
    }
    return value;
  }

  alignByte(): void {
    if (this.bitPos !== 0) {
      this.bitPos = 0;
      this.bytePos += 1;
    }
  }

  skipBytes(count: number): void {
    this.bytePos += count;
    if (this.bytePos > this.buffer.length) throw new Error('deflate stream overruns the pack');
  }

  get position(): number {
    return this.bytePos + (this.bitPos === 0 ? 0 : 1);
  }
}

/** Decode one Huffman symbol (puff.c's decode). */
function huffmanDecode(reader: BitReader, huffman: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len += 1) {
    code |= reader.bits(1);
    const count = huffman.count[len] as number;
    if (code - count < first) return huffman.symbol[index + (code - first)] as number;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('invalid huffman code');
}

/** Walk one compressed block set, counting produced bytes; returns when BFINAL is consumed. */
function deflateWalkBlocks(reader: BitReader, expectedSize: number): void {
  let produced = 0;
  for (;;) {
    const finalBlock = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) {
      reader.alignByte();
      const len = reader.bits(16);
      reader.bits(16); // NLEN, the complement
      reader.skipBytes(len);
      produced += len;
    } else {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        const litLengths = new Array<number>(288);
        for (let i = 0; i < 288; i += 1) litLengths[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
        lit = huffmanBuild(litLengths);
        dist = huffmanBuild(new Array<number>(30).fill(5));
      } else if (type === 2) {
        const hlit = reader.bits(5) + 257;
        const hdist = reader.bits(5) + 1;
        const hclen = reader.bits(4) + 4;
        const clenLengths = new Array<number>(19).fill(0);
        for (let i = 0; i < hclen; i += 1) clenLengths[DEFLATE_CLEN_ORDER[i] as number] = reader.bits(3);
        const clen = huffmanBuild(clenLengths);
        const lengths = new Array<number>(hlit + hdist).fill(0);
        let filled = 0;
        while (filled < hlit + hdist) {
          const sym = huffmanDecode(reader, clen);
          if (sym < 16) {
            lengths[filled] = sym;
            filled += 1;
          } else if (sym === 16) {
            if (filled === 0) throw new Error('repeat with no previous length');
            const previous = lengths[filled - 1] as number;
            const repeat = 3 + reader.bits(2);
            for (let i = 0; i < repeat; i += 1) {
              lengths[filled] = previous;
              filled += 1;
            }
          } else if (sym === 17) {
            filled += 3 + reader.bits(3);
          } else {
            filled += 11 + reader.bits(7);
          }
          if (filled > hlit + hdist) throw new Error('code lengths overrun');
        }
        lit = huffmanBuild(lengths.slice(0, hlit));
        dist = huffmanBuild(lengths.slice(hlit));
      } else {
        throw new Error('invalid deflate block type');
      }
      for (;;) {
        const sym = huffmanDecode(reader, lit);
        if (sym < 256) {
          produced += 1;
        } else if (sym === 256) {
          break;
        } else {
          const lengthIndex = sym - 257;
          if (lengthIndex >= 29) throw new Error('invalid length symbol');
          const length = (DEFLATE_LENGTH_BASE[lengthIndex] as number) + reader.bits(DEFLATE_LENGTH_EXTRA[lengthIndex] as number);
          const distSym = huffmanDecode(reader, dist);
          if (distSym >= 30) throw new Error('invalid distance symbol');
          void ((DEFLATE_DIST_BASE[distSym] as number) + reader.bits(DEFLATE_DIST_EXTRA[distSym] as number));
          produced += length;
        }
        if (produced > expectedSize) throw new Error('deflate produced more than the object size');
      }
    }
    if (finalBlock === 1) break;
  }
  if (produced !== expectedSize) throw new Error('deflate size does not match the object header');
}

/** The exact byte length of the zlib stream at `offset` whose inflated size is `expectedSize`. */
function zlibStreamLength(buffer: Buffer, offset: number, expectedSize: number): number {
  if (offset + 2 > buffer.length) throw new Error('stream too short');
  const cmf = buffer[offset] as number;
  const flg = buffer[offset + 1] as number;
  if ((cmf * 256 + flg) % 31 !== 0 || (cmf & 0x0f) !== 8) throw new Error('not a zlib stream');
  if (flg & 0x20) throw new Error('preset dictionary not supported');
  const reader = new BitReader(buffer, offset + 2);
  deflateWalkBlocks(reader, expectedSize);
  reader.alignByte();
  const total = reader.position - offset + 4; // + adler32
  if (total > buffer.length - offset) throw new Error('stream overruns the pack');
  return total;
}

/** Inflate one pack object: walk for the length when possible, else binary-search it. */
function inflateObject(buffer: Buffer, offset: number, expectedSize: number, maxLength?: number): { data: Buffer; length: number } {
  try {
    const length = zlibStreamLength(buffer, offset, expectedSize);
    const data = inflateSync(buffer.subarray(offset, offset + length));
    if (data.length === expectedSize) return { data, length };
  } catch {
    // Fall through to the search: the walker is an optimization, never the authority.
  }
  if (maxLength !== undefined) {
    const data = inflateSync(buffer.subarray(offset, offset + maxLength));
    if (data.length === expectedSize) return { data, length: maxLength };
    throw new Error('a pack object does not inflate');
  }
  const length = inflatedLength(buffer, offset);
  const data = inflateSync(buffer.subarray(offset, offset + length));
  if (data.length !== expectedSize) throw new Error('pack object size mismatch');
  return { data, length };
}

interface PackObject {
  type: ObjectType;
  data: Buffer;
  /** Byte offset of this object's header inside the pack (for OFS_DELTA bases). */
  offset: number;
}

/** Apply a git delta to its base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Parse a packfile into resolved objects; `external` resolves REF_DELTA bases the pack lacks. */
function parsePack(buffer: Buffer, external?: (oid: string) => GitObject | undefined): PackObject[] {
  if (buffer.length < 12 + 20 || buffer.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const trailer = buffer.subarray(buffer.length - 20);
  const digest = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const raw: { offset: number; kind: string; data: Buffer; baseOffset?: number; baseOid?: string }[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = buffer[offset] as number;
    offset += 1;
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const kind = CODE_TYPES[code] as string;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (kind === 'ofs-delta') {
      let b = buffer[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = buffer[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (kind === 'ref-delta') {
      baseOid = buffer.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const isLast = index === count - 1;
    const { data, length } = inflateObject(buffer, offset, size, isLast ? buffer.length - 20 - offset : undefined);
    offset += length;
    raw.push({ offset: start, kind, data, baseOffset, baseOid });
  }
  const byOffset = new Map<number, PackObject>();
  const resolved: PackObject[] = [];
  const resolve = (entry: (typeof raw)[number]): PackObject => {
    const done = byOffset.get(entry.offset);
    if (done !== undefined) return done;
    let object: PackObject;
    if (entry.kind === 'ofs-delta' || entry.kind === 'ref-delta') {
      let base: PackObject | GitObject | undefined;
      if (entry.kind === 'ofs-delta') {
        const baseEntry = raw.find((candidate) => candidate.offset === entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry);
      } else {
        base = external?.(entry.baseOid as string);
        if (base === undefined) throw new Error('ref-delta base missing');
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data), offset: entry.offset };
    } else {
      object = { type: entry.kind as ObjectType, data: entry.data, offset: entry.offset };
    }
    byOffset.set(entry.offset, object);
    resolved.push(object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing

const ENV_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Whether the request carries the trial's bearer token (any bearer when no token is configured). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  if (ENV_TOKEN !== '') return header === `Bearer ${ENV_TOKEN}`;
  return header.length > 0;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${nextRequestId++}`,
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': `req-${nextRequestId++}`, ...headers });
    res.end();
    return;
  }
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, headers);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

// ---------------------------------------------------------------------------------------------
// Git smart HTTP

const UPLOAD_CAPS_V0 = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The v0 ref advertisement shared by upload-pack (no v2) and receive-pack. */
function advertisementV0(repo: Repo, service: string, capabilities: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`), PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? (refs[0] as [string, string])[1];
  const caps = capabilities.replace('refs/heads/main', headRef);
  parts.push(pktLine(`${headOid} HEAD\u0000${caps}\n`));
  for (const [name, oid] of refs) {
    parts.push(pktLine(`${oid} ${name}\n`));
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = tagTarget(repo, oid);
      if (target !== null) parts.push(pktLine(`${target} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
function advertisementV2(repo: Repo, service: string): Buffer {
  void repo;
  const parts: Buffer[] = [
    pktLine(`# service=${service}\n`),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

function gitInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string, url: URL): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBuffer(res, 403, Buffer.from('unsupported service\n'), 'text/plain; charset=utf-8');
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, advertisementV0(repo, service, RECEIVE_CAPS), contentType);
    return;
  }
  const protocol = req.headers['git-protocol'];
  if (typeof protocol === 'string' && protocol.includes('version=2')) {
    sendBuffer(res, 200, advertisementV2(repo, service), contentType);
    return;
  }
  void url;
  sendBuffer(res, 200, advertisementV0(repo, service, UPLOAD_CAPS_V0), contentType);
}

/** One ls-refs run: the response body for a v2 ls-refs command. */
function gitLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const target = tagTarget(repo, oid);
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Wrap pack bytes in sideband band-1 packets, each within the pkt-line size limit. */
function sidebandWrap(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65500;
  if (pack.length === 0) {
    packets.push(pktLine(Buffer.from([1])));
    return packets;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return packets;
}

interface FetchPlan {
  pack: Buffer;
  shallowLines: string[];
}

/** Compute the pack and shallow-info lines one fetch earns. */
function planFetch(repo: Repo, wants: readonly string[], haves: readonly string[], shallowReq: readonly string[], deepen: number | null): FetchPlan {
  const stopAt = new Set(shallowReq);
  const excluded = closureObjects(repo, haves, stopAt);
  let included: Map<string, GitObject>;
  const includedCommits = new Set<string>();
  if (deepen !== null) {
    // BFS by parent distance from the wants; distance 0 is the wants themselves.
    const distance = new Map<string, number>();
    let frontier: string[] = [];
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type === 'commit' && !distance.has(want)) {
        distance.set(want, 0);
        frontier.push(want);
      }
    }
    for (let depth = 1; depth <= deepen - 1; depth += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        const commit = parseCommit(repo, oid);
        if (commit === null) continue;
        for (const parent of commit.parents) {
          if (!distance.has(parent) && repo.objects.has(parent)) {
            distance.set(parent, depth);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    included = new Map<string, GitObject>();
    for (const oid of distance.keys()) {
      includedCommits.add(oid);
      // A depth-limited commit contributes itself and its tree closure — never its parents.
      const commitObject = repo.objects.get(oid) as GitObject;
      included.set(oid, commitObject);
      const commit = parseCommit(repo, oid);
      if (commit !== null) {
        for (const [childOid, object] of closureObjects(repo, [commit.tree])) included.set(childOid, object);
      }
    }
    // Non-commit wants (tags, trees, blobs) ride along with their full closure.
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type !== 'commit') {
        for (const [childOid, child] of closureObjects(repo, [want])) included.set(childOid, child);
      }
    }
  } else {
    included = closureObjects(repo, wants);
    for (const oid of included.keys()) {
      if ((repo.objects.get(oid) as GitObject).type === 'commit') includedCommits.add(oid);
    }
  }
  for (const oid of excluded.keys()) {
    included.delete(oid);
    includedCommits.delete(oid);
  }
  const shallowLines: string[] = [];
  if (deepen !== null || shallowReq.length > 0) {
    for (const oid of includedCommits) {
      const commit = parseCommit(repo, oid);
      if (commit === null) continue;
      const boundary = commit.parents.some((parent) => repo.objects.has(parent) && !includedCommits.has(parent) && !excluded.has(parent));
      if (boundary && !stopAt.has(oid)) shallowLines.push(`shallow ${oid}`);
      if (!boundary && stopAt.has(oid)) shallowLines.push(`unshallow ${oid}`);
    }
  }
  const ordered: GitObject[] = [];
  const byType = (type: ObjectType): void => {
    for (const [oid, object] of included) if (object.type === type) ordered.push(repo.objects.get(oid) as GitObject);
  };
  byType('commit');
  byType('tag');
  byType('tree');
  byType('blob');
  return { pack: buildPack(ordered), shallowLines };
}

/** The response body of a v2 fetch: optional shallow-info, then the packfile section. */
function fetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandWrap(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Handle one POST to git-upload-pack: a v2 command, or a v0 want list as a fallback. */
function gitUploadPack(res: ServerResponse, repo: Repo, body: Buffer): void {
  const reader = pktReader(body);
  const lines: string[] = [];
  let command = '';
  let sawDelim = false;
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet === 'flush') break;
    if (packet === 'delim') {
      sawDelim = true;
      continue;
    }
    const text = packet.toString('utf8').replace(/\n$/, '');
    if (command === '' && !sawDelim && text.startsWith('command=')) {
      command = text.slice('command='.length);
      continue;
    }
    lines.push(text);
  }
  if (command === 'ls-refs') {
    sendBuffer(res, 200, gitLsRefs(repo, lines), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let deepen: number | null = null;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const parsed = Number.parseInt(line.slice(7), 10);
        if (Number.isFinite(parsed) && parsed > 0) deepen = parsed;
      }
    }
    sendBuffer(res, 200, fetchResponse(planFetch(repo, wants, haves, shallow, deepen)), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === '' && lines.some((line) => line.startsWith('want '))) {
    // A v0 fetch: want/have pkt-lines, then the pack behind a NAK.
    const wants: string[] = [];
    const haves: string[] = [];
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
    const plan = planFetch(repo, wants, haves, [], null);
    const parts: Buffer[] = [pktLine('NAK\n'), ...sidebandWrap(plan.pack), PKT_FLUSH];
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  sendBuffer(res, 400, Buffer.from('unsupported upload-pack request\n'), 'text/plain; charset=utf-8');
}

interface PushCommandRec {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle one POST to git-receive-pack: store the pack, validate each ref update, report. */
function gitReceivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  const reader = pktReader(body);
  const commands: PushCommandRec[] = [];
  let sideband = false;
  let first = true;
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet === 'flush') break;
    if (packet === 'delim') continue;
    let text = packet.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = text.indexOf('\u0000');
      if (nul !== -1) {
        const caps = text.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) sideband = true;
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0] as string) && /^[0-9a-f]{40}$/.test(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = reader.rest();
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of objects) storeObject(repo, object.type, object.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const reportLines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}`);
    };
    if (unpackError !== null) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        fail('bad object');
        continue;
      }
      if (current !== ZERO_OID && !isAncestor(repo, current, command.newOid)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  const reportParts: Buffer[] = reportLines.map((line) => pktLine(`${line}\n`));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (sideband) {
    const packets: Buffer[] = [];
    const CHUNK = 65500;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    packets.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(packets), 'application/x-git-receive-pack-result');
    return;
  }
  sendBuffer(res, 200, report, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------------------------
// Shared serializers and merge machinery (REST, GraphQL and MCP all read the same store)

function isoFromSeq(seq: number): string {
  return new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString();
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type, name: VIEWER.name, email: VIEWER.email };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', default: false, description: null };
}

function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: globalId('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    author: userJson(),
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: isoFromSeq(issue.seq),
    updated_at: isoFromSeq(issue.seq),
    closed_at: issue.state === 'closed' ? isoFromSeq(issue.seq + 1) : null,
  };
}

function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: globalId('P', repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: isoFromSeq(pull.seq),
    updated_at: isoFromSeq(pull.seq),
  };
}

function commentJson(repo: Repo, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('C', repo.id, comment.id),
    body: comment.body,
    user: userJson(),
    author: userJson(),
    created_at: isoFromSeq(comment.seq),
    updated_at: isoFromSeq(comment.seq),
  };
}

/** Opaque, stable Relay-style global ids: base64 of a typed, colon-joined key. */
function globalId(kind: string, ...parts: readonly number[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { kind: string; parts: number[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Z]):(\d+(?::\d+)*)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1] as string, parts: (match[2] as string).split(':').map((part) => Number(part)) };
  } catch {
    return null;
  }
}

interface MergeAttempt {
  ok: boolean;
  sha: string | null;
}

/**
 * Three-way merge of a pull request's head into its base, per file: a path the head changed
 * applies cleanly unless the base also changed it to something else. On success the base ref
 * advances to the new commit (squash: one parent; merge: two) and the attempt names its sha.
 */
function tryMerge(repo: Repo, pull: PullRec, method: string): MergeAttempt {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { ok: false, sha: null };
  const base0 = mergeBase(repo, headTip, baseTip);
  if (base0 === null) return { ok: false, sha: null };
  const atBase = commitFiles(repo, base0);
  const atHead = commitFiles(repo, headTip);
  const atBaseNow = commitFiles(repo, baseTip);
  const result = new Map(atBaseNow);
  const paths = new Set([...atBase.keys(), ...atHead.keys()]);
  for (const path of paths) {
    const before = atBase.get(path);
    const head = atHead.get(path);
    if (before === head) continue;
    const current = atBaseNow.get(path);
    if (current === before) {
      if (head === undefined) result.delete(path);
      else result.set(path, head);
    } else if (current !== head) {
      return { ok: false, sha: null };
    }
  }
  const tree = buildTreeFromFiles(repo, result);
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(repo, tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}`);
  } else {
    sha = makeCommit(repo, tree, [baseTip], `${pull.title} (#${pull.number})`);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now (GraphQL's `mergeable`). */
function pullMergeable(repo: Repo, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base0 = mergeBase(repo, headTip, baseTip);
  if (base0 === null) return 'CONFLICTING';
  const atBase = commitFiles(repo, base0);
  const atHead = commitFiles(repo, headTip);
  const atBaseNow = commitFiles(repo, baseTip);
  for (const path of new Set([...atBase.keys(), ...atHead.keys()])) {
    const before = atBase.get(path);
    const head = atHead.get(path);
    if (before === head) continue;
    const current = atBaseNow.get(path);
    if (current !== before && current !== head) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-diff counts between two blob texts (LCS over lines; blobs here are small). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const splitLines = (text: string): string[] => {
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The files a pull request changes, diffed from the merge base to the head tip. */
function pullFiles(repo: Repo, pull: PullRec): FileChange[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  const base0 = mergeBase(repo, headTip, baseTip) ?? pull.baseShaAtCreate;
  const from = commitFiles(repo, base0);
  const to = commitFiles(repo, headTip);
  const changes: FileChange[] = [];
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) continue;
    const oldText = before === undefined ? '' : (repo.objects.get(before)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (repo.objects.get(after)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** Commit a single-file change (or deletion, when `blobOid` is null) on a branch ref. */
function commitFileChange(repo: Repo, branchRef: string, path: string, blobOid: string | null, message: string): { commitSha: string; existed: boolean } {
  const tip = repo.refs.get(branchRef);
  const files = tip === undefined ? new Map<string, string>() : commitFiles(repo, tip);
  const existed = files.has(path);
  if (blobOid === null) files.delete(path);
  else files.set(path, blobOid);
  const tree = buildTreeFromFiles(repo, files);
  const commitSha = makeCommit(repo, tree, tip === undefined ? [] : [tip], message);
  repo.refs.set(branchRef, commitSha);
  return { commitSha, existed };
}

// ---------------------------------------------------------------------------------------------
// REST v3

type Json = Record<string, unknown>;

function parsePageParams(url: URL): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

function pageSlice<T>(items: readonly T[], url: URL): T[] {
  const { page, perPage } = parsePageParams(url);
  return items.slice((page - 1) * perPage, page * perPage);
}

/** The Link header for the viewer's repository list (the one pagination the suite follows). */
function listLinkHeader(req: IncomingMessage, url: URL, total: number): string | null {
  const { page, perPage } = parsePageParams(url);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const parts = [`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`, `<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`];
  return parts.join(', ');
}

function commitJson(repo: Repo, oid: string): Json {
  const commit = parseCommit(repo, oid);
  return {
    sha: oid,
    commit: {
      author: { name: commit?.authorName ?? '', email: commit?.authorEmail ?? '', date: commit?.authorDate ?? '' },
      committer: { name: commit?.committerName ?? '', email: commit?.committerEmail ?? '', date: commit?.committerDate ?? '' },
      message: commit?.message ?? '',
      tree: { sha: commit?.tree ?? ZERO_OID },
    },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
    author: { login: VIEWER.login },
    committer: { login: VIEWER.login },
  };
}

/** Commits reachable from a tip, newest first (first parent walked first). */
function listCommits(repo: Repo, tip: string, limit: number): Json[] {
  const out: Json[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = parseCommit(repo, oid);
    if (commit === null) continue;
    out.push(commitJson(repo, oid));
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void {
  const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';

  const readJson = (): Json | null => {
    if (body.length === 0) return {};
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      return parsed as Json;
    } catch {
      return null;
    }
  };
  const badBody = (): void => sendError(res, 400, 'Problems parsing JSON');
  const notFound = (): void => sendError(res, 404, 'Not Found');

  if (rest.length === 0) {
    if (method !== 'GET') return notFound();
    return sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org, user' },
    );
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    return sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    return sendJson(res, 200, userJson());
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
      const link = listLinkHeader(req, url, mine.length);
      return sendJson(res, 200, pageSlice(mine, url).map(repoJson), link === null ? {} : { link });
    }
    if (method === 'POST') {
      const data = readJson();
      if (data === null) return badBody();
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') return sendError(res, 422, 'Repository creation failed.');
      if (findRepo(VIEWER.login, name) !== null) return sendError(res, 422, 'name already exists on this account');
      const repo = createRepo(
        VIEWER.login,
        name,
        typeof data.description === 'string' ? data.description : '',
        typeof data.private === 'boolean' ? data.private : false,
      );
      return sendJson(res, 201, repoJson(repo));
    }
    return notFound();
  }

  if (rest[0] !== 'repos' || rest.length < 3) return notFound();
  const repo = findRepo(rest[1] as string, rest[2] as string);
  if (repo === null) return notFound();
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const data = readJson();
      if (data === null) return badBody();
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      if (typeof data.name === 'string' && data.name !== '' && data.name !== repo.name) {
        repos.delete(repoKey(repo.owner, repo.name));
        repo.name = data.name;
        repos.set(repoKey(repo.owner, repo.name), repo);
      }
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      return sendJson(res, 204, null);
    }
    return notFound();
  }

  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return sendJson(res, 200, branches);
  }
  if (tail[0] === 'branches' && tail.length >= 2 && method === 'GET') {
    const name = tail.slice(1).join('/');
    const oid = repo.refs.get(`refs/heads/${name}`);
    if (oid === undefined) return notFound();
    return sendJson(res, 200, { name, commit: { sha: oid }, protected: false });
  }

  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam === null || shaParam === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveCommit(repo, shaParam);
    if (tip === undefined || tip === null) return sendJson(res, 200, []);
    const { perPage } = parsePageParams(url);
    return sendJson(res, 200, listCommits(repo, tip, perPage));
  }

  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
    if (method === 'GET') {
      const list = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }));
      return sendJson(res, 200, list);
    }
    if (method === 'POST') {
      const data = readJson();
      if (data === null) return badBody();
      const ref = typeof data.ref === 'string' ? data.ref : '';
      const sha = typeof data.sha === 'string' ? data.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return sendError(res, 422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return notFound();
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length >= 3 && method === 'GET') {
    const ref = `refs/${tail.slice(2).join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) return notFound();
    return sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    return handleContents(req, res, url, repo, path, body, readJson, notFound, badBody);
  }

  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'GET') return sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
    if (method === 'POST') {
      const data = readJson();
      if (data === null) return badBody();
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') return sendError(res, 422, 'Invalid label');
      if (repo.labels.has(name)) return sendError(res, 422, 'Validation Failed: label already exists');
      const label: LabelRec = { name, color: typeof data.color === 'string' ? data.color : 'ededed' };
      repo.labels.set(name, label);
      return sendJson(res, 201, { name: label.name, color: label.color, default: false, description: null });
    }
    return notFound();
  }

  if (tail[0] === 'issues' && tail.length === 1) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendJson(res, 200, pageSlice(list, url).map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST') {
      const data = readJson();
      if (data === null) return badBody();
      return createIssueRest(res, repo, data);
    }
    return notFound();
  }

  if (tail[0] === 'issues' && tail.length >= 2) {
    const number = Number.parseInt(tail[1] as string, 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const data = readJson();
        if (data === null) return badBody();
        if (typeof data.title === 'string') issue.title = data.title;
        if (typeof data.body === 'string') issue.body = data.body;
        if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
        if (Array.isArray(data.labels)) {
          const names = data.labels.filter((entry): entry is string => typeof entry === 'string');
          for (const name of names) if (!repo.labels.has(name)) return sendError(res, 422, `Label '${name}' not found`);
          issue.labels = names;
        }
        return sendJson(res, 200, issueJson(repo, issue));
      }
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (issue === undefined && pull === undefined) return notFound();
      if (method === 'GET') {
        const list = (repo.comments.get(number) ?? []).map((comment) => commentJson(repo, comment));
        return sendJson(res, 200, list);
      }
      if (method === 'POST') {
        const data = readJson();
        if (data === null) return badBody();
        const comment: CommentRec = {
          id: repo.nextCommentId++,
          body: typeof data.body === 'string' ? data.body : '',
          seq: nextSeq++,
        };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return sendJson(res, 201, commentJson(repo, comment));
      }
      return notFound();
    }
    return notFound();
  }

  if (tail[0] === 'pulls' && tail.length === 1) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      return sendJson(res, 200, pageSlice(list, url).map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST') {
      const data = readJson();
      if (data === null) return badBody();
      return createPullRest(res, repo, data);
    }
    return notFound();
  }

  if (tail[0] === 'pulls' && tail.length >= 2) {
    const number = Number.parseInt(tail[1] as string, 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 2 && method === 'GET') {
      if (pull === undefined) return notFound();
      return sendJson(res, 200, pullJson(repo, pull));
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      return sendJson(res, 200, pullFiles(repo, pull));
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      const data = readJson();
      if (data === null) return badBody();
      if (pull.state !== 'open') return sendError(res, 405, 'Pull Request is not mergeable');
      const method2 = typeof data.merge_method === 'string' ? data.merge_method : 'merge';
      const attempt = tryMerge(repo, pull, method2 === 'squash' ? 'squash' : 'merge');
      if (!attempt.ok || attempt.sha === null) return sendError(res, 405, 'Pull Request is not mergeable');
      return sendJson(res, 200, { sha: attempt.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}

/** POST /issues against the store (shared validation for the REST route). */
function createIssueRest(res: ServerResponse, repo: Repo, data: Json): void {
  const title = typeof data.title === 'string' ? data.title : '';
  if (title === '') return sendError(res, 422, 'Validation Failed: title is required');
  const labelNames: string[] = [];
  if (Array.isArray(data.labels)) {
    for (const entry of data.labels) {
      if (typeof entry === 'string') labelNames.push(entry);
      else if (typeof entry === 'object' && entry !== null && typeof (entry as Json).name === 'string') labelNames.push((entry as Json).name as string);
    }
  }
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return sendError(res, 422, `Label '${name}' not found`);
  }
  const issue: IssueRec = {
    number: repo.nextNumber++,
    title,
    body: typeof data.body === 'string' ? data.body : '',
    state: 'open',
    labels: labelNames,
    seq: nextSeq++,
  };
  repo.issues.set(issue.number, issue);
  return sendJson(res, 201, issueJson(repo, issue));
}

/** Normalize a pull-request head/base value ('refs/heads/x', 'owner:x', 'x') to a branch name. */
function branchNameOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  let name = value;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.lastIndexOf(':');
  if (colon !== -1) name = name.slice(colon + 1);
  return name;
}

/** POST /pulls against the store. */
function createPullRest(res: ServerResponse, repo: Repo, data: Json): void {
  const head = branchNameOf(data.head);
  const base = branchNameOf(data.base);
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (head === '' || headSha === undefined) return sendError(res, 422, `Invalid head branch`);
  if (base === '' || baseSha === undefined) return sendError(res, 422, `Invalid base branch`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return sendError(res, 422, `A pull request already exists for ${head} into ${base}`);
    }
  }
  const pull: PullRec = {
    number: repo.nextNumber++,
    title: typeof data.title === 'string' ? data.title : '',
    body: typeof data.body === 'string' ? data.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    headShaAtCreate: headSha,
    baseShaAtCreate: baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: nextSeq++,
  };
  repo.pulls.set(pull.number, pull);
  return sendJson(res, 201, pullJson(repo, pull));
}

/** The contents API: GET (file or directory), PUT (create/update with a commit), DELETE. */
function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  path: string,
  body: Buffer,
  readJson: () => Json | null,
  notFound: () => void,
  badBody: () => void,
): void {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const refParam = url.searchParams.get('ref');
    const tip = refParam === null || refParam === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveCommit(repo, refParam);
    if (tip === undefined || tip === null) return notFound();
    const commit = parseCommit(repo, tip);
    if (commit === null) return notFound();
    let treeOid = commit.tree;
    if (path === '') {
      return sendJson(res, 200, treeListing(repo, treeOid, ''));
    }
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const treeObject = repo.objects.get(treeOid);
      if (treeObject === undefined || treeObject.type !== 'tree') return notFound();
      const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return notFound();
      const last = i === segments.length - 1;
      if (entry.mode === '40000') {
        if (last) return sendJson(res, 200, treeListing(repo, entry.oid, path));
        treeOid = entry.oid;
        continue;
      }
      if (!last) return notFound();
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return notFound();
      return sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob.data.length,
      });
    }
    return notFound();
  }
  if (method === 'PUT') {
    const data = readJson();
    if (data === null) return badBody();
    if (path === '') return sendError(res, 422, 'Invalid path');
    const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    if (!repo.refs.has(branchRef)) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) repo.refs.set(branchRef, defaultTip);
    }
    const tip = repo.refs.get(branchRef);
    const files = tip === undefined ? new Map<string, string>() : commitFiles(repo, tip);
    const existing = files.get(path);
    if (existing !== undefined && typeof data.sha === 'string' && data.sha !== '' && data.sha !== existing) {
      return sendError(res, 409, `${path} does not match ${data.sha}`);
    }
    const contentBase64 = typeof data.content === 'string' ? data.content.replace(/\s+/g, '') : '';
    const blobOid = storeObject(repo, 'blob', Buffer.from(contentBase64, 'base64'));
    const message = typeof data.message === 'string' ? data.message : 'Update file';
    const { commitSha } = commitFileChange(repo, branchRef, path, blobOid, message);
    const commit = parseCommit(repo, commitSha);
    const blob = repo.objects.get(blobOid);
    return sendJson(res, existing === undefined ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: blob?.data.length ?? 0,
        type: 'file',
        encoding: 'base64',
      },
      commit: {
        sha: commitSha,
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: new Date().toISOString() },
        committer: { name: VIEWER.name, email: VIEWER.email, date: new Date().toISOString() },
        tree: { sha: commit?.tree ?? ZERO_OID },
        parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
      },
    });
  }
  if (method === 'DELETE') {
    const data = readJson();
    if (data === null) return badBody();
    const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined) return notFound();
    const files = commitFiles(repo, tip);
    const existing = files.get(path);
    if (existing === undefined) return notFound();
    if (typeof data.sha === 'string' && data.sha !== '' && data.sha !== existing) {
      return sendError(res, 409, `${path} does not match ${data.sha}`);
    }
    const message = typeof data.message === 'string' ? data.message : 'Delete file';
    const { commitSha } = commitFileChange(repo, branchRef, path, null, message);
    return sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
  }
  return notFound();
}

/** One directory's contents-API listing. */
function treeListing(repo: Repo, treeOid: string, prefix: string): Json[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: blob?.data.length ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4 (POST /api/graphql): a small parser and executor for the gh-shaped documents.

type GqlValue = { kind: 'var'; name: string } | { kind: 'lit'; value: unknown };

interface GqlField {
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  selection: GqlField[] | null;
  typeCondition: string | null; // set for inline fragments (name is '')
}

function gqlTokenize(input: string): { kind: string; value: string }[] {
  const tokens: { kind: string; value: string }[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!@=|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const text = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          text += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: { kind: string; value: string }[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = gqlTokenize(input);
  }

  private peek(): { kind: string; value: string } | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): { kind: string; value: string } {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  /** Skip a balanced (...) group (variable definitions, directives). */
  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.value === '(') depth += 1;
      else if (token.value === ')') depth -= 1;
    }
  }

  parseDocument(): { type: 'query' | 'mutation'; name: string | null; selection: GqlField[] }[] {
    const operations: { type: 'query' | 'mutation'; name: string | null; selection: GqlField[] }[] = [];
    while (this.peek() !== null) {
      const token = this.peek() as { kind: string; value: string };
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        const after = this.peek();
        if (after !== null && after.kind === 'name') name = this.next().value;
        if (this.peek()?.value === '(') this.skipParens();
        while (this.peek()?.value === '@') {
          this.next();
          this.next();
          if (this.peek()?.value === '(') this.skipParens();
        }
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.next();
        this.next();
        this.next();
        this.parseSelectionSet();
        continue;
      }
      this.next();
    }
    return operations;
  }

  parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== null && this.peek()?.value !== '}') fields.push(this.parseField());
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    const token = this.peek() as { kind: string; value: string };
    if (token.kind === 'spread') {
      this.next();
      const on = this.next(); // 'on'
      void on;
      const typeName = this.next().value;
      const selection = this.parseSelectionSet();
      return { name: '', alias: null, args: new Map(), selection, typeCondition: typeName };
    }
    let name = this.next().value;
    let alias: string | null = null;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = new Map<string, GqlValue>();
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() !== null && this.peek()?.value !== ')') {
        const argName = this.next().value;
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    while (this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.value === '(') this.skipParens();
    }
    let selection: GqlField[] | null = null;
    if (this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { name, alias, args, selection, typeCondition: null };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.value === '$') return { kind: 'var', name: this.next().value };
    if (token.kind === 'string') return { kind: 'lit', value: token.value };
    if (token.kind === 'number') return { kind: 'lit', value: Number(token.value) };
    if (token.value === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== null && this.peek()?.value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'lit', value: items };
    }
    if (token.value === '{') {
      const object = new Map<string, GqlValue>();
      while (this.peek() !== null && this.peek()?.value !== '}') {
        const key = this.next().value;
        this.expect(':');
        object.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'lit', value: object };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'lit', value: true };
      if (token.value === 'false') return { kind: 'lit', value: false };
      if (token.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'lit', value: token.value }; // an enum, carried as its name
    }
    return { kind: 'lit', value: null };
  }
}

/** Resolve a parsed argument value against the operation's variables. */
function gqlResolve(value: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  if (value.kind === 'var') return variables[value.name] ?? null;
  const raw = value.value;
  if (raw instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of raw) out[key] = gqlResolve(entry, variables);
    return out;
  }
  if (Array.isArray(raw)) return raw.map((entry) => gqlResolve(entry as GqlValue, variables));
  return raw;
}

const GQL_TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'comments', 'labels', 'repository', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'commits', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'repository', 'url',
  ],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const GQL_TYPE_INFO: Readonly<Record<string, { kind: string; fields?: readonly string[]; enumValues?: readonly string[] }>> = {
  Issue: { kind: 'OBJECT', fields: GQL_TYPE_FIELDS.Issue },
  PullRequest: { kind: 'OBJECT', fields: GQL_TYPE_FIELDS.PullRequest },
  Repository: { kind: 'OBJECT', fields: GQL_TYPE_FIELDS.Repository },
  User: { kind: 'OBJECT', fields: GQL_TYPE_FIELDS.User },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

interface GqlTagged {
  __typename: string;
  [key: string]: unknown;
}

function tag(typename: string, payload: Record<string, unknown>): GqlTagged {
  return { __typename: typename, ...payload };
}

interface GqlExec {
  variables: Readonly<Record<string, unknown>>;
  errors: { message: string }[];
}

function cursorEncode(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorDecode(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

/** Slice a connection's items by first/after and shape the connection payload. */
function connectionPage(items: readonly GqlTagged[], args: ReadonlyMap<string, GqlValue>, exec: GqlExec): { nodes: GqlTagged[]; pageInfo: GqlTagged; totalCount: number } {
  const firstRaw = args.has('first') ? gqlResolve(args.get('first') as GqlValue, exec.variables) : null;
  const first = typeof firstRaw === 'number' && firstRaw > 0 ? Math.trunc(firstRaw) : items.length;
  const afterRaw = args.has('after') ? gqlResolve(args.get('after') as GqlValue, exec.variables) : null;
  const start = Math.max(0, cursorDecode(afterRaw) + 1);
  const nodes = items.slice(start, start + first);
  const hasNextPage = start + nodes.length < items.length;
  const endCursor = nodes.length > 0 ? cursorEncode(start + nodes.length - 1) : null;
  return {
    nodes,
    pageInfo: tag('PageInfo', { hasNextPage, endCursor, hasPreviousPage: start > 0, startCursor: nodes.length > 0 ? cursorEncode(start) : null }),
    totalCount: items.length,
  };
}

function gqlRepo(repo: Repo): GqlTagged {
  return tag('Repository', { repo });
}

function gqlIssue(repo: Repo, issue: IssueRec): GqlTagged {
  return tag('Issue', { repo, issue });
}

function gqlPull(repo: Repo, pull: PullRec): GqlTagged {
  return tag('PullRequest', { repo, pull });
}

function findRepoById(id: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

/** Resolve one field of one tagged object; validation and recursion live in gqlComplete. */
function gqlField(exec: GqlExec, source: GqlTagged, field: GqlField): unknown {
  const typename = source.__typename;
  const name = field.name;
  const arg = (key: string): unknown => (field.args.has(key) ? gqlResolve(field.args.get(key) as GqlValue, exec.variables) : undefined);

  if (typename === 'Query') {
    if (name === 'viewer') return tag('User', {});
    if (name === 'repository') {
      const repo = findRepo(String(arg('owner') ?? ''), String(arg('name') ?? ''));
      return repo === null ? null : gqlRepo(repo);
    }
    if (name === 'node') {
      const parsed = parseGlobalId(String(arg('id') ?? ''));
      if (parsed === null) return null;
      if (parsed.kind === 'R') {
        const repo = findRepoById(parsed.parts[0] as number);
        return repo === null ? null : gqlRepo(repo);
      }
      if (parsed.kind === 'I' || parsed.kind === 'P') {
        const repo = findRepoById(parsed.parts[0] as number);
        if (repo === null) return null;
        const record = parsed.kind === 'I' ? repo.issues.get(parsed.parts[1] as number) : repo.pulls.get(parsed.parts[1] as number);
        if (record === undefined) return null;
        return parsed.kind === 'I' ? gqlIssue(repo, record as IssueRec) : gqlPull(repo, record as PullRec);
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(arg('name') ?? '');
      const info = GQL_TYPE_INFO[typeName];
      if (info === undefined) return null;
      return tag('__Type', { typeName, info });
    }
    if (name === '__schema') return null;
  }

  if (typename === 'Mutation') {
    const input = (arg('input') ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.kind === 'R' ? findRepoById(parsed.parts[0] as number) : null;
      if (repo === null) throw new Error('repository not found');
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        seq: nextSeq++,
      };
      repo.issues.set(issue.number, issue);
      return tag('CreateIssuePayload', { issue: gqlIssue(repo, issue), clientMutationId: null });
    }
    if (name === 'closeIssue') {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      const repo = parsed !== null ? findRepoById(parsed.parts[0] as number) : null;
      const issue = repo?.issues.get(parsed?.parts[1] as number);
      if (repo === null || repo === undefined || issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      return tag('CloseIssuePayload', { issue: gqlIssue(repo, issue), clientMutationId: null });
    }
    if (name === 'createPullRequest') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.kind === 'R' ? findRepoById(parsed.parts[0] as number) : null;
      if (repo === null) throw new Error('repository not found');
      const head = branchNameOf(input.headRefName);
      const base = branchNameOf(input.baseRefName);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) throw new Error('invalid head or base branch');
      const pull: PullRec = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef: head,
        baseRef: base,
        headShaAtCreate: headSha,
        baseShaAtCreate: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: nextSeq++,
      };
      repo.pulls.set(pull.number, pull);
      return tag('CreatePullRequestPayload', { pullRequest: gqlPull(repo, pull), clientMutationId: null });
    }
    if (name === 'mergePullRequest') {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parsed !== null ? findRepoById(parsed.parts[0] as number) : null;
      const pull = repo?.pulls.get(parsed?.parts[1] as number);
      if (repo === null || repo === undefined || pull === undefined) throw new Error('pull request not found');
      if (pull.state !== 'open') throw new Error('pull request is not open');
      const method = String(input.mergeMethod ?? 'MERGE');
      const attempt = tryMerge(repo, pull, method === 'SQUASH' ? 'squash' : 'merge');
      if (!attempt.ok) throw new Error('Pull Request is not mergeable');
      return tag('MergePullRequestPayload', { pullRequest: gqlPull(repo, pull), clientMutationId: null });
    }
    if (name === 'addComment') {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      const repo = parsed !== null ? findRepoById(parsed.parts[0] as number) : null;
      if (repo === null || repo === undefined) throw new Error('subject not found');
      const number = parsed?.parts[1] as number;
      if (repo.issues.get(number) === undefined && repo.pulls.get(number) === undefined) throw new Error('subject not found');
      const comment: CommentRec = { id: repo.nextCommentId++, body: String(input.body ?? ''), seq: nextSeq++ };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      const node = tag('IssueComment', { id: globalId('C', repo.id, comment.id), body: comment.body });
      return tag('AddCommentPayload', { commentEdge: tag('CommentEdge', { node, cursor: cursorEncode(list.length - 1) }), clientMutationId: null });
    }
  }

  if (typename === 'User') {
    if (name === 'login') return VIEWER.login;
    if (name === 'id') return globalId('U', VIEWER.id);
    if (name === 'name') return VIEWER.name;
    if (name === 'email') return VIEWER.email;
  }

  if (typename === 'Repository') {
    const repo = source.repo as Repo;
    switch (name) {
      case 'id': return globalId('R', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return tag('User', {});
      case 'defaultBranchRef': {
        const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return oid === undefined ? null : tag('Ref', { name: repo.defaultBranch });
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'isPrivate': return repo.isPrivate;
      case 'description': return repo.description;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.createdAt;
      case 'url': return `/${repo.owner}/${repo.name}`;
      case 'issue': {
        const issue = repo.issues.get(Number(arg('number')));
        return issue === undefined ? null : gqlIssue(repo, issue);
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = arg('states');
        if (Array.isArray(states)) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = arg('orderBy') as { direction?: string } | undefined;
        const descending = orderBy !== undefined && orderBy !== null ? orderBy.direction !== 'ASC' : field.args.has('orderBy');
        list.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
        const page = connectionPage(list.map((issue) => gqlIssue(repo, issue)), field.args, exec);
        return tag('IssueConnection', page);
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(arg('number')));
        return pull === undefined ? null : gqlPull(repo, pull);
      }
      case 'pullRequests': {
        const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
        const page = connectionPage(list.map((pull) => gqlPull(repo, pull)), field.args, exec);
        return tag('PullRequestConnection', page);
      }
      default: return null;
    }
  }

  if (typename === 'Issue') {
    const issue = source.issue as IssueRec;
    const repo = source.repo as Repo;
    switch (name) {
      case 'id': return globalId('I', repo.id, issue.number);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'author': return tag('User', {});
      case 'createdAt': return isoFromSeq(issue.seq);
      case 'updatedAt': return isoFromSeq(issue.seq);
      case 'closedAt': return issue.state === 'closed' ? isoFromSeq(issue.seq + 1) : null;
      case 'repository': return gqlRepo(repo);
      case 'url': return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
      default: return null;
    }
  }

  if (typename === 'PullRequest') {
    const pull = source.pull as PullRec;
    const repo = source.repo as Repo;
    switch (name) {
      case 'id': return globalId('P', repo.id, pull.number);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'mergeable': return pullMergeable(repo, pull);
      case 'author': return tag('User', {});
      case 'createdAt': return isoFromSeq(pull.seq);
      case 'updatedAt': return isoFromSeq(pull.seq);
      case 'mergedAt': return pull.mergedAt;
      case 'repository': return gqlRepo(repo);
      case 'url': return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const paths = pullFiles(repo, pull).map((change) => tag('PullRequestChangedFile', { path: change.filename }));
        const page = connectionPage(paths, field.args, exec);
        return tag('PullRequestChangedFileConnection', page);
      }
      default: return null;
    }
  }

  if (typename === 'Ref' && name === 'name') return source.name as string;
  if (typename === '__Type') {
    const info = source.info as { kind: string; fields?: readonly string[]; enumValues?: readonly string[] };
    if (name === 'name') return source.typeName as string;
    if (name === 'kind') return info.kind;
    if (name === 'fields') return (info.fields ?? []).map((fieldName) => tag('__Field', { name: fieldName }));
    if (name === 'enumValues') return (info.enumValues ?? []).map((value) => tag('__EnumValue', { name: value }));
    if (name === 'description') return null;
  }
  if (typename === '__Field' || typename === '__EnumValue') {
    if (name === 'name') return source.name as string;
    if (name === 'description') return null;
  }
  // Payload and connection objects carry their fields as plain properties.
  if (name in source) return source[name];
  return null;
}

/** Complete a tagged object against a selection set, recording unknown-field errors. */
function gqlComplete(exec: GqlExec, source: GqlTagged, selection: readonly GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typename = source.__typename;
  for (const field of selection) {
    if (field.typeCondition !== null) {
      if (field.typeCondition === typename && field.selection !== null) Object.assign(out, gqlComplete(exec, source, field.selection));
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typename;
      continue;
    }
    const known = (GQL_TYPE_FIELDS[typename] ?? []).includes(field.name) || field.name === '__type' || field.name === '__schema';
    if (!known) {
      exec.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typename}'` });
      out[key] = null;
      continue;
    }
    let raw: unknown;
    try {
      raw = gqlField(exec, source, field);
    } catch (err) {
      exec.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = gqlCompleteValue(exec, raw, field.selection);
  }
  return out;
}

function gqlCompleteValue(exec: GqlExec, raw: unknown, selection: readonly GqlField[] | null): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((entry) => gqlCompleteValue(exec, entry, selection));
  if (typeof raw === 'object' && '__typename' in (raw as Record<string, unknown>)) {
    if (selection === null) return null;
    return gqlComplete(exec, raw as GqlTagged, selection);
  }
  return raw;
}

/** Execute one GraphQL operation document; returns the response body object. */
function gqlExecute(document: string, variables: Readonly<Record<string, unknown>>, operationName: string | null): Record<string, unknown> {
  const exec: GqlExec = { variables, errors: [] };
  let operations: { type: 'query' | 'mutation'; name: string | null; selection: GqlField[] }[];
  try {
    operations = new GqlParser(document).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operations.find((candidate) => operationName === null || candidate.name === operationName) ?? operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const root = tag(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = gqlComplete(exec, root, operation.selection);
  const body: Record<string, unknown> = { data };
  if (exec.errors.length > 0) body.errors = exec.errors;
  return body;
}

function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!authorized(req)) return sendError(res, 401, 'Requires authentication');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'invalid operation' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    if (query === '') return { data: null, errors: [{ message: 'no query' }] };
    return gqlExecute(query, variables, operationName);
  };
  if (Array.isArray(parsed)) return sendJson(res, 200, parsed.map(runOne));
  return sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------------------------------------
// MCP (POST /mcp): JSON-RPC tools over the same store, legacy handshake era.

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

function mcpTool(name: string, description: string, properties: Record<string, string>, required: string[]): McpToolDef {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [key, kind] of Object.entries(properties)) {
    props[key] = { type: kind === 'number' ? 'number' : kind === 'boolean' ? 'boolean' : 'string', description: `${key} for ${name}` };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  mcpTool('create_repo', 'Create a repository owned by the authenticated user', { name: 'string', description: 'string', private: 'boolean' }, ['name']),
  mcpTool('get_repo', 'Read one repository by owner and name', { owner: 'string', repo: 'string' }, ['owner', 'repo']),
  mcpTool('create_issue', 'Create an issue in a repository', { owner: 'string', repo: 'string', title: 'string', body: 'string' }, ['owner', 'repo', 'title']),
  mcpTool('list_issues', 'List the issues of a repository', { owner: 'string', repo: 'string', state: 'string' }, ['owner', 'repo']),
  mcpTool('get_issue', 'Read one issue by number', { owner: 'string', repo: 'string', issue_number: 'number' }, ['owner', 'repo', 'issue_number']),
  mcpTool('create_pull_request', 'Open a pull request from a head branch into a base branch', { owner: 'string', repo: 'string', title: 'string', body: 'string', head: 'string', base: 'string' }, ['owner', 'repo', 'title', 'head', 'base']),
  mcpTool('list_pull_requests', 'List the pull requests of a repository', { owner: 'string', repo: 'string', state: 'string' }, ['owner', 'repo']),
  mcpTool('merge_pull_request', 'Merge a pull request', { owner: 'string', repo: 'string', pull_number: 'number' }, ['owner', 'repo', 'pull_number']),
]);

interface McpOutcome {
  value?: unknown;
  toolError?: string;
  rpcError?: { code: number; message: string };
}

function mcpCallTool(name: string, args: Record<string, unknown>): McpOutcome {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { rpcError: { code: -32601, message: `unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return { rpcError: { code: -32602, message: `missing required argument: ${required}` } };
    }
  }
  const repoFor = (): Repo | null => findRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (findRepo(VIEWER.login, repoName) !== null) return { toolError: `repository ${repoName} already exists` };
      const repo = createRepo(VIEWER.login, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = repoFor();
      if (repo === null) return { toolError: 'repository not found' };
      return { value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = repoFor();
      if (repo === null) return { toolError: 'repository not found' };
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        seq: nextSeq++,
      };
      repo.issues.set(issue.number, issue);
      return { value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = repoFor();
      if (repo === null) return { toolError: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return { value: list.map((issue) => issueJson(repo, issue)) };
    }
    case 'get_issue': {
      const repo = repoFor();
      if (repo === null) return { toolError: 'repository not found' };
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { toolError: 'issue not found' };
      return { value: issueJson(repo, issue) };
    }
    case 'create_pull_request': {
      const repo = repoFor();
      if (repo === null) return { toolError: 'repository not found' };
      const head = branchNameOf(args.head);
      const base = branchNameOf(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return { toolError: 'invalid head or base branch' };
      const pull: PullRec = {
        number: repo.nextNumber++,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headShaAtCreate: headSha,
        baseShaAtCreate: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: nextSeq++,
      };
      repo.pulls.set(pull.number, pull);
      return { value: pullJson(repo, pull) };
    }
    case 'list_pull_requests': {
      const repo = repoFor();
      if (repo === null) return { toolError: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      return { value: list.map((pull) => pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = repoFor();
      if (repo === null) return { toolError: 'repository not found' };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { toolError: 'pull request not found' };
      if (pull.state !== 'open') return { toolError: 'pull request is not open' };
      const attempt = tryMerge(repo, pull, 'squash');
      if (!attempt.ok || attempt.sha === null) return { toolError: 'Pull Request is not mergeable' };
      return { value: { ...pullJson(repo, pull), sha: attempt.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    default:
      return { rpcError: { code: -32601, message: `unknown tool: ${name}` } };
  }
}

function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (!authorized(req)) return sendError(res, 401, 'Requires authentication');

  const handleOne = (entry: unknown): Record<string, unknown> | null => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const request = entry as Record<string, unknown>;
    const method = typeof request.method === 'string' ? request.method : '';
    const id = 'id' in request ? request.id : undefined;
    const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
    if (id === undefined || method.startsWith('notifications/')) return null; // a notification: no answer
    const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
    const failWith = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
        return ok({ protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: 'forge-mcp', version: '1.0.0' } });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: MCP_TOOLS });
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        const outcome = mcpCallTool(toolName, args);
        if (outcome.rpcError !== undefined) return failWith(outcome.rpcError.code, outcome.rpcError.message);
        if (outcome.toolError !== undefined) {
          return ok({ content: [{ type: 'text', text: outcome.toolError }], isError: true });
        }
        return ok({
          content: [{ type: 'text', text: JSON.stringify(outcome.value ?? null) }],
          structuredContent: outcome.value ?? null,
          isError: false,
        });
      }
      default:
        // server/discover included: this server predates it, which the client reads as the
        // legacy era and answers with the initialize handshake.
        return failWith(-32601, `Method not found: ${method}`);
    }
  };

  if (Array.isArray(parsed)) {
    const answers = parsed.map(handleOne).filter((entry) => entry !== null);
    if (answers.length === 0) {
      res.writeHead(202, { 'x-github-request-id': `req-${nextRequestId++}` });
      res.end();
      return;
    }
    return sendJson(res, 200, answers);
  }
  const answer = handleOne(parsed);
  if (answer === null) {
    res.writeHead(202, { 'x-github-request-id': `req-${nextRequestId++}` });
    res.end();
    return;
  }
  return sendJson(res, 200, answer);
}

// ---------------------------------------------------------------------------------------------
// Router

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  if (path === '/api/graphql') {
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    return handleGraphQL(req, res, body);
  }
  if (path === '/mcp') {
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    return handleMcp(req, res, body);
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) return sendError(res, 401, 'Requires authentication');
    return handleRest(req, res, url, body);
  }

  // Git smart HTTP: /<owner>/<repo>[.git]/<endpoint>
  const segments = path.split('/').filter((part) => part !== '').map(decodeSegment);
  if (segments.length >= 3) {
    const owner = segments[0] as string;
    const repoSegment = segments[1] as string;
    const repoName = repoSegment.endsWith('.git') ? repoSegment.slice(0, -'.git'.length) : repoSegment;
    const tail = segments.slice(2).join('/');
    if (tail === 'info/refs' || tail === 'git-upload-pack' || tail === 'git-receive-pack') {
      const repo = findRepo(owner, repoName);
      if (repo === null) return sendError(res, 404, 'Not Found');
      if (tail === 'info/refs' && method === 'GET') {
        return gitInfoRefs(req, res, repo, url.searchParams.get('service') ?? '', url);
      }
      if (tail === 'git-upload-pack' && method === 'POST') return gitUploadPack(res, repo, body);
      if (tail === 'git-receive-pack' && method === 'POST') return gitReceivePack(res, repo, body);
      return sendError(res, 404, 'Not Found');
    }
  }

  return sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res).catch(() => {
      try {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is already gone; a failed request must never take the process down.
      }
    });
  });
}
