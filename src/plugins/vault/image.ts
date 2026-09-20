import { lookup } from 'node:dns/promises';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

import type { ExtraTool, ToolResult } from './merge.js';
import {
  MAX_EDGE,
  canonicalExtension,
  extensionOf,
  isImagePath,
  parseDimensions,
  prepareImage,
  probeDimensions,
  sniffFormat,
  type Dimensions,
} from './media.js';
import { insideVault, parseEmbeds, resolveTarget, walkVault } from './paths.js';

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
      const prepared = await prepareImage(full, original, maxEdge);

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
      const notes = files.filter((file) => file.toLowerCase().endsWith('.md'));

      const referencedBy = new Map<string, string[]>();
      const broken: { embed: string; inNote: string }[] = [];

      for (const note of notes) {
        const markdown = await readFile(insideVault(options.vaultPath, note), 'utf8');
        for (const target of parseEmbeds(markdown)) {
          const matches = resolveTarget(target, files);
          if (matches.length === 0) {
            // Only an image-looking target is reported: `![[some note]]` is a
            // note transclusion, not a missing attachment.
            if (isImagePath(target)) broken.push({ embed: target, inNote: note });
            continue;
          }
          for (const match of matches) {
            if (!isImagePath(match)) continue;
            const seen = referencedBy.get(match);
            if (seen === undefined) referencedBy.set(match, [note]);
            else if (!seen.includes(note)) seen.push(note);
          }
        }
      }

      if (status === 'broken') {
        const rows = broken.slice(0, limit);
        return result(`${broken.length} broken image embeds across ${notes.length} notes.`, {
          brokenCount: broken.length,
          broken: rows,
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

      const rows = [];
      for (const image of selected.slice(0, limit)) {
        const full = insideVault(options.vaultPath, image);
        const { size } = await stat(full);
        const dimensions = extensionOf(image) === 'svg' ? undefined : parseDimensions(await readHead(full, 1024));
        rows.push({
          path: image,
          bytes: size,
          ...(dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height }),
          referencedBy: referencedBy.get(image) ?? [],
        });
      }

      const orphans = images.filter((image) => !referencedBy.has(image)).length;
      return result(
        `${selected.length} of ${images.length} images matched${selected.length > rows.length ? `, showing ${rows.length}` : ''}. ${orphans} orphaned, ${broken.length} broken embeds.`,
        { matched: selected.length, totalImages: images.length, orphanCount: orphans, brokenCount: broken.length, images: rows },
      );
    },
  };
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
 * The daemon is exposed to the internet through a tunnel, so a URL import is
 * a way to ask it to make a request from inside the home network. This is
 * checked at resolution time and `fetch` resolves again, so it narrows the
 * hole rather than closing it — good enough for a personal service, and the
 * reason the check exists at all.
 */
function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalised = address.toLowerCase();
    return (
      normalised === '::1' ||
      normalised === '::' ||
      normalised.startsWith('fe80') ||
      normalised.startsWith('fc') ||
      normalised.startsWith('fd')
    );
  }
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

async function download(rawUrl: string): Promise<Buffer> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be imported: ${url.protocol}`);
  }
  for (const { address } of await lookup(url.hostname, { all: true })) {
    if (isPrivateAddress(address)) throw new Error(`Refusing to fetch a private address: ${url.hostname}`);
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) throw new Error(`That URL is not an image: ${contentType || 'no content-type'}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_WRITE_BYTES) throw new Error(`Image is larger than ${MAX_WRITE_BYTES} bytes.`);
  return bytes;
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
      const expected = canonicalExtension(format);
      if (extension !== expected && !(expected === 'jpg' && extension === 'jpeg')) {
        throw new Error(`The data is ${format.toUpperCase()} but the path ends in .${extension}. Use .${expected}.`);
      }

      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);

      const dimensions = parseDimensions(bytes);
      const embedded = embedIn === undefined ? undefined : await appendEmbed(options.vaultPath, embedIn, path, alt);

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

/** Append an embed to a note, using the short form when the name is unambiguous. */
async function appendEmbed(
  vaultPath: string,
  notePath: string,
  imagePath: string,
  alt: string | undefined,
): Promise<string> {
  const note = insideVault(vaultPath, notePath.toLowerCase().endsWith('.md') ? notePath : `${notePath}.md`);
  const markdown = await readFile(note, 'utf8').catch(() => {
    throw new Error(`No note to embed into: ${notePath}`);
  });

  const files = await walkVault(vaultPath);
  const basename = imagePath.slice(imagePath.lastIndexOf('/') + 1);
  const target = resolveTarget(basename, files).length === 1 ? basename : imagePath;
  const embed = alt === undefined ? `![[${target}]]` : `![[${target}|${alt}]]`;

  await writeFile(note, `${markdown.replace(/\s*$/, '')}\n\n${embed}\n`, 'utf8');
  return embed;
}

/** The image tools, in the order they should appear in a listing. */
export function imageTools(options: ImageToolOptions): ExtraTool<never>[] {
  const tools = [readImageTool(options), findImagesTool(options)];
  if (options.readOnly !== true) tools.push(writeImageTool(options));
  return tools as unknown as ExtraTool<never>[];
}
