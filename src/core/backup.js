/**
 * Backup — one file that holds a whole chats folder, and a restore that proves
 * it came back unchanged.
 *
 * There is no archive library here and there is not going to be one: this
 * project has no dependencies. The format is deliberately dull.
 *
 *   bytes 0..3    magic 'LSBK'
 *   bytes 4..7    format version, uint32 LE
 *   bytes 8..11   header length in bytes, uint32 LE
 *   bytes 12..    header, UTF-8 JSON: every entry with its path, byte length
 *                 and SHA-256, plus the digest of the whole payload
 *   then          the file contents, concatenated in header order, gzipped
 *                 (node:zlib is a builtin, so this stays dependency-free)
 *
 * The digests are the point. A restore verifies every one of them before it
 * writes a single byte, so a truncated or edited archive is refused with the
 * destination still untouched — a half-restored chat folder is worse than no
 * restore at all, because it looks like it worked.
 *
 * Restoring into a folder that already holds files is refused as well. The
 * caller has to say `force: true`, which is the CLI's `--force`, so nobody
 * loses a conversation to a mistyped path.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const MAGIC = 'LSBK';
const FORMAT = 1;
const PREFIX_BYTES = 12;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Write every file under `chatsDir` into a single archive at `target`.
 *
 * Everything in the folder is taken, not just `*.json`: a backup that quietly
 * dropped files it did not recognise would not be a backup.
 *
 * @returns {Promise<{ok: true, target: string, files: number, bytes: number, archiveBytes: number}>}
 */
export async function createBackup({ chatsDir, target } = {}) {
  if (!chatsDir || !target) throw new Error('createBackup needs { chatsDir, target }');

  const root = path.resolve(chatsDir);
  const out = path.resolve(target);

  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    throw new Error(`nothing to back up: ${root} does not exist`);
  }
  if (!stat.isDirectory()) throw new Error(`not a folder: ${root}`);

  const entries = await collect(root);
  const payload = Buffer.concat(entries.map((e) => e.data));
  const packed = await gzip(payload, { level: 9 });

  const header = {
    magic: MAGIC,
    format: FORMAT,
    tool: 'landslide-local',
    createdAt: new Date().toISOString(),
    codec: 'gzip',
    source: root,
    payloadBytes: payload.length,
    payloadSha256: sha256(payload),
    entries: entries.map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })),
  };
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');

  const prefix = Buffer.alloc(PREFIX_BYTES);
  prefix.write(MAGIC, 0, 'latin1');
  prefix.writeUInt32LE(FORMAT, 4);
  prefix.writeUInt32LE(headerJson.length, 8);

  const archive = Buffer.concat([prefix, headerJson, packed]);

  await fs.mkdir(path.dirname(out), { recursive: true });
  // Written aside and renamed: an interrupted backup must not replace a good
  // archive with a truncated one.
  const partial = `${out}.partial`;
  await fs.writeFile(partial, archive);
  await fs.rename(partial, out);

  return {
    ok: true,
    target: out,
    files: entries.length,
    bytes: payload.length,
    archiveBytes: archive.length,
  };
}

/**
 * Unpack an archive into `chatsDir`.
 *
 * Refuses a non-empty destination unless `force` is set, and refuses a corrupt
 * archive outright — in that case nothing is written and nothing is created.
 *
 * @returns {Promise<{ok: true, chatsDir: string, files: number, bytes: number}>}
 */
export async function restoreBackup({ archive, chatsDir, force = false } = {}) {
  if (!archive || !chatsDir) throw new Error('restoreBackup needs { archive, chatsDir }');

  const dest = path.resolve(chatsDir);
  const raw = await fs.readFile(path.resolve(archive));

  // Everything below happens in memory. Not one byte reaches `dest` until the
  // whole archive has been read, decompressed and checked against its digests.
  const pieces = await parse(raw);

  const existing = await listing(dest);
  if (existing.length > 0 && !force) {
    throw new Error(
      `refusing to restore into ${dest}: it already holds ${existing.length} file(s). ` +
        `Move them aside, restore somewhere else, or re-run with --force to write over them.`,
    );
  }

  await fs.mkdir(dest, { recursive: true });
  let bytes = 0;
  for (const piece of pieces) {
    const file = path.join(dest, piece.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, piece.data);
    bytes += piece.data.length;
  }

  return { ok: true, chatsDir: dest, files: pieces.length, bytes };
}

/** Read an archive's header without unpacking it — used by the CLI to describe one. */
export async function inspectBackup({ archive } = {}) {
  if (!archive) throw new Error('inspectBackup needs { archive }');
  const raw = await fs.readFile(path.resolve(archive));
  const header = readHeader(raw);
  return {
    format: header.format,
    createdAt: header.createdAt ?? null,
    source: header.source ?? null,
    files: header.entries.length,
    bytes: header.payloadBytes,
  };
}

/* ------------------------------------------------------------------ */

async function collect(root) {
  const found = [];
  const walk = async (dir, prefix) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const data = await fs.readFile(full);
        found.push({ path: rel, bytes: data.length, sha256: sha256(data), data });
      }
    }
  };
  await walk(root, '');
  return found;
}

function corrupt(detail) {
  const err = new Error(`this archive is not usable: ${detail}`);
  err.code = 'EBADARCHIVE';
  return err;
}

function readHeader(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < PREFIX_BYTES) throw corrupt('too short to be one');
  if (raw.subarray(0, 4).toString('latin1') !== MAGIC) throw corrupt('wrong file type');

  const format = raw.readUInt32LE(4);
  if (format !== FORMAT) throw corrupt(`unknown format version ${format}`);

  const headerBytes = raw.readUInt32LE(8);
  if (headerBytes === 0 || headerBytes > MAX_HEADER_BYTES) throw corrupt('header length is nonsense');
  if (PREFIX_BYTES + headerBytes > raw.length) throw corrupt('truncated before the header ended');

  let header;
  try {
    header = JSON.parse(raw.subarray(PREFIX_BYTES, PREFIX_BYTES + headerBytes).toString('utf8'));
  } catch {
    throw corrupt('the header is not valid JSON');
  }
  if (!header || typeof header !== 'object' || !Array.isArray(header.entries)) {
    throw corrupt('the header has no entry list');
  }
  if (!Number.isInteger(header.payloadBytes) || header.payloadBytes < 0) {
    throw corrupt('the header does not say how big the payload is');
  }
  header.headerBytes = headerBytes;
  return header;
}

async function parse(raw) {
  const header = readHeader(raw);
  const body = raw.subarray(PREFIX_BYTES + header.headerBytes);

  let payload;
  if (header.codec === 'gzip') {
    try {
      payload = await gunzip(body);
    } catch {
      throw corrupt('the compressed payload could not be read');
    }
  } else if (header.codec === 'raw' || header.codec === undefined) {
    payload = Buffer.from(body);
  } else {
    throw corrupt(`unknown codec ${String(header.codec)}`);
  }

  if (payload.length !== header.payloadBytes) throw corrupt('the payload is the wrong length');
  if (header.payloadSha256 && sha256(payload) !== header.payloadSha256) {
    throw corrupt('the payload does not match its checksum');
  }

  const pieces = [];
  let offset = 0;
  for (const entry of header.entries) {
    if (!entry || typeof entry.path !== 'string' || !Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw corrupt('an entry is malformed');
    }
    const rel = safeRelative(entry.path);
    const data = payload.subarray(offset, offset + entry.bytes);
    if (data.length !== entry.bytes) throw corrupt(`entry ${entry.path} runs past the end`);
    if (entry.sha256 && sha256(data) !== entry.sha256) throw corrupt(`entry ${entry.path} is damaged`);
    pieces.push({ path: rel, data: Buffer.from(data) });
    offset += entry.bytes;
  }
  if (offset !== payload.length) throw corrupt('the payload holds bytes no entry claims');
  return pieces;
}

/**
 * An archive is untrusted input like any other. A path that climbs out of the
 * destination, or names a drive, is a rejection rather than a write.
 */
function safeRelative(name) {
  const cleaned = name.replace(/\\/g, '/');
  if (cleaned.length === 0) throw corrupt('an entry has no name');
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) throw corrupt(`absolute path in archive: ${name}`);
  const parts = cleaned.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) throw corrupt(`unsafe path in archive: ${name}`);
  return path.join(...parts);
}

async function listing(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
