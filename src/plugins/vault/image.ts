import { lookup } from 'node:dns/promises';
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import type { ExtraTool, ToolResult } from './merge.js';
import {
  MAX_EDGE,
  canonicalExtension,
  extensionMatchesFormat,
  extensionOf,
  isImagePath,
  parseDimensions,
  prepareImage,
  probeDimensions,
  sniffFormat,
  type Dimensions,
} from './media.js';
import { canvasRefs, frontmatterRefs, insideVault, parseEmbeds, resolveTarget, walkVault } from './paths.js';

/** Ceiling on one file written into the vault. */
const MAX_WRITE_BYTES = 25_000_000;

/** How much of a file is read to identify it and measure it. */
const HEADER_BYTES = 65_536;

/** An SVG is returned as its source, so a huge one is truncated rather than dumped. */
const MAX_SVG_CHARS = 200_000;

export interface ImageToolOptions {
  vaultPath: string;
  /**
   * Directories outside the vault that `write_image` may copy from.
   *
   * Empty by default: the mount otherwise touches nothing but the vault, and
   * a tool that reads arbitrary local paths would quietly widen that.
   */
  importRoots?: readonly string[];
  /** Expose the reading tools only. */
  readOnly?: boolean;
}

function result(summary: string, data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

async function readHead(path: string, bytes = HEADER_BYTES): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function measure(full: string, head: Buffer): Promise<Dimensions | undefined> {
  return parseDimensions(head) ?? (await probeDimensions(full));
}

/** First read when only the dimensions are wanted, before falling back to more. */
const QUICK_HEADER_BYTES = 1024;

/**
 * Dimensions for a listing, reading as little as will answer.
 *
 * PNG, GIF and WebP put their size in the first few dozen bytes. A JPEG puts
 * it after every metadata segment, and a photo carrying an EXIF thumbnail
 * pushes that well past a kilobyte — those were being listed with no
 * dimensions at all. The longer read only happens when the short one came
 * back with nothing and there is actually more file to read.
 */
async function listingDimensions(full: string): Promise<Dimensions | undefined> {
  const brief = await readHead(full, QUICK_HEADER_BYTES);
  const answered = parseDimensions(brief);
  if (answered !== undefined || brief.byteLength < QUICK_HEADER_BYTES) return answered;
  return parseDimensions(await readHead(full));
}

/** Find the one image an embed target names, or explain why there is not one. */
async function locate(vaultPath: string, target: string): Promise<string> {
  const files = await walkVault(vaultPath);
  const matches = resolveTarget(target, files).filter(isImagePath);

  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const named = files.filter(isImagePath).length;
    throw new Error(
      named === 0
        ? `No image matches "${target}" — the vault holds no image files yet.`
        : `No image matches "${target}". Use find_images to see the ${named} images in the vault.`,
    );
  }
  throw new Error(`"${target}" matches ${matches.length} images; pass a full path: ${matches.join(', ')}`);
}

const readSchema = z.object({
  path: z.string().min(1).describe('Vault-relative path to the image, or the filename as an embed writes it.'),
  maxEdge: z
    .number()
    .int()
    .min(64)
    .max(4096)
    .optional()
    .describe(`Longest edge in pixels before downscaling. Defaults to ${MAX_EDGE}.`),
});

function readImageTool(options: ImageToolOptions): ExtraTool<z.infer<typeof readSchema>> {
  return {
    name: 'read_image',
    title: 'Read image',
    description:
      'Return an image attachment from the vault so it can actually be looked at — a screenshot, a diagram, a photo. Takes a vault-relative path or the bare filename an embed uses (`![[diagram.png]]` → `diagram.png`). Large images are downscaled and formats like HEIC are converted to PNG on the way out; the original file is never modified. SVG comes back as its source text.',
    schema: readSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ path, maxEdge = MAX_EDGE }) => {
      const found = await locate(options.vaultPath, path);
      const full = insideVault(options.vaultPath, found);
      const { size } = await stat(full);

      if (extensionOf(found) === 'svg') {
        const source = await readFile(full, 'utf8');
        const clipped = source.length > MAX_SVG_CHARS;
        return {
          content: [
            {
              type: 'text',
              text: `${found} (SVG, ${size} bytes)${clipped ? ', truncated' : ''}\n\n${source.slice(0, MAX_SVG_CHARS)}`,
            },
          ],
        };
      }

      const head = await readHead(full);
      const original = await measure(full, head);
      const prepared = await prepareImage(full, original, maxEdge, size);

      const described = original === undefined ? 'unknown size' : `${original.width}×${original.height}`;
      const notes = prepared.note === undefined ? '' : ` — ${prepared.note}`;
      return {
        content: [
          { type: 'image', data: prepared.data.toString('base64'), mimeType: prepared.mimeType },
          { type: 'text', text: `${found} (${described}, ${size} bytes on disk)${notes}` },
        ],
      };
    },
  };
}

interface References {
  /** Image path → the notes and canvases that use it. */
  referencedBy: Map<string, string[]>;
  /** Embeds whose target is nowhere in the vault. */
  broken: { embed: string; inNote: string }[];
  noteCount: number;
}

/**
 * Work out which images are in use, and which embeds point at nothing.
 *
 * Three places count as a use: an embed in a note body, an image named in
 * frontmatter (a cover or a banner), and a file node on a canvas. Only the
 * first can report a broken link — frontmatter is read loosely, so an
 * over-eager token there would invent a missing file.
 */
async function scanReferences(vaultPath: string, files: readonly string[]): Promise<References> {
  const notes = files.filter((file) => file.toLowerCase().endsWith('.md'));
  const canvases = files.filter((file) => file.toLowerCase().endsWith('.canvas'));

  const referencedBy = new Map<string, string[]>();
  const broken: { embed: string; inNote: string }[] = [];

  const record = (matches: readonly string[], source: string): void => {
    for (const match of matches) {
      if (!isImagePath(match)) continue;
      const seen = referencedBy.get(match);
      if (seen === undefined) referencedBy.set(match, [source]);
      else if (!seen.includes(source)) seen.push(source);
    }
  };

  for (const note of notes) {
    const markdown = await readFile(insideVault(vaultPath, note), 'utf8');

    for (const target of parseEmbeds(markdown)) {
      const matches = resolveTarget(target, files);
      if (matches.length === 0) {
        // `![[some note]]` is a note transclusion, not a missing attachment.
        if (isImagePath(target)) broken.push({ embed: target, inNote: note });
        continue;
      }
      record(matches, note);
    }

    for (const target of frontmatterRefs(markdown)) record(resolveTarget(target, files), note);
  }

  for (const canvas of canvases) {
    const board = await readFile(insideVault(vaultPath, canvas), 'utf8');
    for (const target of canvasRefs(board)) record(resolveTarget(target, files), canvas);
  }

  return { referencedBy, broken, noteCount: notes.length };
}

const findSchema = z.object({
  query: z.string().optional().describe('Case-insensitive substring of the path or filename.'),
  folder: z.string().optional().describe('Restrict the search to one folder, vault-relative.'),
  status: z
    .enum(['all', 'orphan', 'broken'])
    .optional()
    .describe('`orphan` lists images no note embeds; `broken` lists embeds pointing at a file that is not there.'),
  limit: z.number().int().min(1).max(500).optional().describe('Maximum rows to return. Defaults to 100.'),
});

function findImagesTool(options: ImageToolOptions): ExtraTool<z.infer<typeof findSchema>> {
  return {
    name: 'find_images',
    title: 'Find images',
    description:
      'List the image attachments in the vault with their size, dimensions and which notes embed them. Filter by filename or folder, or set `status` to find orphans (images nothing links to) and broken embeds (links with no file behind them).',
    schema: findSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ query, folder, status = 'all', limit = 100 }) => {
      const files = await walkVault(options.vaultPath);
      const images = files.filter(isImagePath);
      const { referencedBy, broken, noteCount } = await scanReferences(options.vaultPath, files);

      if (status === 'broken') {
        return result(`${broken.length} broken image embeds across ${noteCount} notes.`, {
          brokenCount: broken.length,
          broken: broken.slice(0, limit),
        });
      }

      const wanted = query?.toLowerCase();
      const prefix = folder === undefined ? undefined : `${folder.replace(/\/+$/, '')}/`;
      const selected = images.filter((image) => {
        if (wanted !== undefined && !image.toLowerCase().includes(wanted)) return false;
        if (prefix !== undefined && !image.startsWith(prefix)) return false;
        if (status === 'orphan' && referencedBy.has(image)) return false;
        return true;
      });

      let selectedBytes = 0;
      const rows = [];
      for (const image of selected) {
        const full = insideVault(options.vaultPath, image);
        const { size } = await stat(full);
        selectedBytes += size;
        if (rows.length >= limit) continue;
        const dimensions = extensionOf(image) === 'svg' ? undefined : await listingDimensions(full);
        rows.push({
          path: image,
          bytes: size,
          ...(dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height }),
          referencedBy: referencedBy.get(image) ?? [],
        });
      }

      const orphans = images.filter((image) => !referencedBy.has(image)).length;
      return result(
        `${selected.length} of ${images.length} images matched${selected.length > rows.length ? `, showing ${rows.length}` : ''}, ${megabytes(selectedBytes)}. ${orphans} orphaned, ${broken.length} broken embeds.`,
        {
          matched: selected.length,
          totalImages: images.length,
          matchedBytes: selectedBytes,
          orphanCount: orphans,
          brokenCount: broken.length,
          images: rows,
        },
      );
    },
  };
}

function megabytes(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.round(bytes / 1000)} kB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

const writeSchema = z
  .object({
    path: z.string().min(1).describe('Destination inside the vault, e.g. `attachments/diagram.png`.'),
    data: z.string().optional().describe('The image itself, base64-encoded.'),
    sourcePath: z.string().optional().describe('Absolute path of a local file to copy in, if importing is enabled.'),
    url: z.string().url().optional().describe('http(s) URL to download the image from.'),
    overwrite: z.boolean().optional().describe('Replace the file if it already exists. Defaults to false.'),
    embedIn: z.string().optional().describe('Note to append an Obsidian embed to once the file is written.'),
    alt: z.string().optional().describe('Alt text for the embed.'),
  })
  .refine(
    (value) => [value.data, value.sourcePath, value.url].filter((source) => source !== undefined).length === 1,
    { message: 'Give exactly one of data, sourcePath or url.' },
  );

/**
 * Addresses that must not be reachable through this tool.
 *
 * Exported so the ranges can be asserted directly: the tool itself refuses
 * every address a test could stand a server on, so there is no way to reach
 * this through `write_image`.
 *
 * The daemon is exposed to the internet through a tunnel, so a URL import is
 * a way to ask it to make a request from inside the home network. Every hop
 * is checked, not just the first, because otherwise a public host could
 * redirect to a private one. `fetch` resolves again after the check, so this
 * narrows the hole rather than closing it — good enough for a personal
 * service, and the reason the check exists at all.
 */
export function isPrivateAddress(address: string): boolean {
  const normalised = address.trim().toLowerCase();

  if (normalised.includes(':')) {
    // An IPv4-mapped address is an IPv4 destination in IPv6 notation, in
    // either spelling. A host that answers AAAA with `::ffff:127.0.0.1`
    // would otherwise skip every IPv4 rule below.
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalised);
    if (dotted !== null) return isPrivateAddress(dotted[1]!);

    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalised);
    if (hex !== null) {
      const high = Number.parseInt(hex[1]!, 16);
      const low = Number.parseInt(hex[2]!, 16);
      return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }

    if (normalised === '::1' || normalised === '::') return true;
    if (/^fe[89ab]/.test(normalised)) return true; // link-local, fe80::/10
    if (/^f[cd]/.test(normalised)) return true; // unique local, fc00::/7
    return false;
  }

  const parts = normalised.split('.');
  const octets = parts.map(Number);
  // Anything that is not a plain dotted quad is something this cannot reason
  // about, and guessing in the permissive direction is the wrong way to be
  // wrong here.
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;

  const [a = 0, b = 0, c = 0] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT, where Tailscale lives
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Redirects are followed by hand so each hop can be checked; four is plenty. */
const MAX_REDIRECTS = 4;

async function download(rawUrl: string): Promise<Buffer> {
  let url = new URL(rawUrl);
  let response: Response;

  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Only http and https URLs can be imported: ${url.protocol}`);
    }
    for (const { address } of await lookup(url.hostname, { all: true })) {
      if (isPrivateAddress(address)) throw new Error(`Refusing to fetch a private address: ${url.hostname}`);
    }

    response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) break;

    const location = response.headers.get('location');
    if (location === null) throw new Error(`${url.href} redirected without saying where.`);
    if (hop >= MAX_REDIRECTS) throw new Error(`${rawUrl} redirected more than ${MAX_REDIRECTS} times.`);
    url = new URL(location, url);
  }

  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);

  // Header values are not required to be lower case.
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error(`That URL is not an image: ${contentType || 'no content-type'}`);

  return await drain(response);
}

/**
 * Read a response body, stopping the moment it goes over the limit.
 *
 * Buffering first and measuring afterwards makes the limit advisory: the
 * bytes are already in memory by the time it is checked, so a server that
 * answers with gigabytes takes the daemon with it. `content-length` is
 * consulted first because it is free, and then ignored — it is absent on a
 * chunked response and can simply be wrong.
 */
export async function drain(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_WRITE_BYTES) {
    throw new Error(`That image declares ${declared} bytes, over the ${MAX_WRITE_BYTES} byte limit.`);
  }
  if (response.body === null) throw new Error('That URL returned no body.');

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.byteLength;
    if (received > MAX_WRITE_BYTES) {
      // Leaving the loop cancels the stream, so the rest is never pulled.
      throw new Error(`That image is larger than ${MAX_WRITE_BYTES} bytes.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function importLocal(sourcePath: string, importRoots: readonly string[]): Promise<Buffer> {
  if (importRoots.length === 0) {
    throw new Error('Importing from a local path is off. Set PORTCALL_VAULT_IMPORT_DIRS to the folders it may read.');
  }
  if (!isAbsolute(sourcePath)) throw new Error(`sourcePath must be absolute: ${sourcePath}`);

  const full = resolve(sourcePath);
  const permitted = importRoots.some((root) => {
    const rel = relative(resolve(root), full);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!permitted) throw new Error(`${full} is not inside an allowed import folder.`);

  const { size } = await stat(full);
  if (size > MAX_WRITE_BYTES) throw new Error(`Image is larger than ${MAX_WRITE_BYTES} bytes.`);
  return await readFile(full);
}

function writeImageTool(options: ImageToolOptions): ExtraTool<z.infer<typeof writeSchema>> {
  const importRoots = options.importRoots ?? [];

  return {
    name: 'write_image',
    title: 'Write image',
    description:
      'Save an image into the vault — from base64 data, a URL, or a local file when importing is enabled — and optionally append an Obsidian embed to a note. The bytes are checked against the destination extension, so a file that is not an image is refused.',
    schema: writeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async ({ path, data, sourcePath, url, overwrite = false, embedIn, alt }) => {
      if (!isImagePath(path)) throw new Error(`Not an image extension: ${path}`);
      const destination = insideVault(options.vaultPath, path);

      const existing = await stat(destination).catch(() => undefined);
      if (existing !== undefined && !overwrite) {
        throw new Error(`${path} already exists. Pass overwrite: true to replace it.`);
      }

      // Opened before a single byte is written. Discovering the note is
      // missing afterwards left the image in the vault while telling the
      // caller only that the embed failed — and the corrected retry then hit
      // the overwrite guard for a file it did not know it had created.
      const note = embedIn === undefined ? undefined : await openNote(options.vaultPath, embedIn);

      const bytes =
        data !== undefined
          ? Buffer.from(data, 'base64')
          : sourcePath !== undefined
            ? await importLocal(sourcePath, importRoots)
            : await download(url!);

      if (bytes.byteLength === 0) throw new Error('The image is empty.');
      if (bytes.byteLength > MAX_WRITE_BYTES) throw new Error(`Image is larger than ${MAX_WRITE_BYTES} bytes.`);

      const format = sniffFormat(bytes);
      if (format === undefined) throw new Error('Those bytes are not a recognised image format.');
      const extension = extensionOf(path);
      if (!extensionMatchesFormat(extension, format)) {
        throw new Error(
          `The data is ${format.toUpperCase()} but the path ends in .${extension}. Use .${canonicalExtension(format)}.`,
        );
      }

      await mkdir(dirname(destination), { recursive: true });
      await place(destination, bytes);

      const dimensions = parseDimensions(bytes);
      const embedded = note === undefined ? undefined : await appendEmbed(options.vaultPath, note, path, alt);

      return result(
        `Wrote ${path} (${bytes.byteLength} bytes${dimensions === undefined ? '' : `, ${dimensions.width}×${dimensions.height}`})${embedded === undefined ? '' : ` and embedded it in ${embedIn}`}.`,
        {
          path,
          bytes: bytes.byteLength,
          format,
          ...(dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height }),
          replaced: existing !== undefined,
          ...(embedded === undefined ? {} : { embed: embedded }),
        },
      );
    },
  };
}

/**
 * Put a file in place in one step.
 *
 * Written straight to its destination, a crash mid-write leaves a truncated
 * image under a name that says it is a whole one — and this vault has no
 * backup behind it. The staging file is a dotfile so a vault walk that lands
 * in between does not list it.
 */
async function place(destination: string, bytes: Buffer): Promise<void> {
  const staging = join(dirname(destination), `.portcall-${process.pid}-${basename(destination)}.tmp`);
  try {
    await writeFile(staging, bytes);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Find the note an embed will be appended to, before anything is written.
 *
 * Only the path is carried forward. Keeping the body read here and writing
 * that copy back afterwards would discard anything typed into the note in
 * between — and a URL import spends the whole download inside that window.
 * The read still happens, because proving the note is readable is the point.
 */
async function openNote(vaultPath: string, notePath: string): Promise<string> {
  const full = insideVault(vaultPath, notePath.toLowerCase().endsWith('.md') ? notePath : `${notePath}.md`);
  await readFile(full, 'utf8').catch(() => {
    throw new Error(`No note to embed into: ${notePath}`);
  });
  return full;
}

/** Append an embed to a note, using the short form when the name is unambiguous. */
async function appendEmbed(vaultPath: string, note: string, imagePath: string, alt: string | undefined): Promise<string> {
  const files = await walkVault(vaultPath);
  const name = imagePath.slice(imagePath.lastIndexOf('/') + 1);
  const target = resolveTarget(name, files).length === 1 ? name : imagePath;
  const embed = alt === undefined ? `![[${target}]]` : `![[${target}|${alt}]]`;

  // Read at the moment of writing, not when the call started.
  const markdown = await readFile(note, 'utf8');
  await writeFile(note, `${markdown.replace(/\s*$/, '')}\n\n${embed}\n`, 'utf8');
  return embed;
}

const deleteSchema = z.object({
  path: z.string().min(1).describe('Vault-relative path of the image to delete, exactly as find_images prints it.'),
  confirmPath: z.string().min(1).describe('Must match `path` character for character.'),
  force: z.boolean().optional().describe('Delete even though a note or canvas still uses it. Defaults to false.'),
});

function deleteImageTool(options: ImageToolOptions): ExtraTool<z.infer<typeof deleteSchema>> {
  return {
    name: 'delete_image',
    title: 'Delete image',
    description:
      'Delete an image attachment from the vault, for clearing out the orphans find_images turns up. Needs the exact path repeated in `confirmPath`, and refuses an image that a note, its frontmatter or a canvas still uses unless `force` is set. This is not the Obsidian trash: the file is gone.',
    schema: deleteSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async ({ path, confirmPath, force = false }) => {
      if (path !== confirmPath) {
        throw new Error('confirmPath does not match path. Both must be identical for a delete to go ahead.');
      }
      if (!isImagePath(path)) throw new Error(`Not an image extension: ${path}`);

      const files = await walkVault(options.vaultPath);
      if (!files.includes(path)) {
        // A near miss is named rather than acted on: deleting whatever a
        // partial name happened to match is not a mistake worth allowing.
        const near = resolveTarget(path, files).filter(isImagePath);
        throw new Error(
          near.length === 0
            ? `No such image: ${path}`
            : `${path} is not a vault path. Did you mean ${near.join(' or ')}?`,
        );
      }

      const { referencedBy } = await scanReferences(options.vaultPath, files);
      const users = referencedBy.get(path) ?? [];
      if (users.length > 0 && !force) {
        throw new Error(`${path} is still used by ${users.join(', ')}. Pass force: true to delete it anyway.`);
      }

      const full = insideVault(options.vaultPath, path);
      const { size } = await stat(full);
      await unlink(full);

      return result(
        `Deleted ${path} (${size} bytes)${users.length === 0 ? '' : `, which was used by ${users.join(', ')}`}.`,
        { path, bytes: size, wasUsedBy: users },
      );
    },
  };
}

/** The image tools, in the order they should appear in a listing. */
export function imageTools(options: ImageToolOptions): ExtraTool<never>[] {
  const tools: unknown[] = [readImageTool(options), findImagesTool(options)];
  if (options.readOnly !== true) tools.push(writeImageTool(options), deleteImageTool(options));
  return tools as ExtraTool<never>[];
}
