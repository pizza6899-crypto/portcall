import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Image formats a model can be handed directly. Anything else has to be
 * transcoded first, so it is listed separately.
 */
const NATIVE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Raster formats Obsidian will happily store that need converting to PNG. */
const TRANSCODED_TYPES: Record<string, string> = {
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  ico: 'image/vnd.microsoft.icon',
};

/** SVG is markup: it is an image to Obsidian but text everywhere here. */
export const SVG_TYPE = 'image/svg+xml';

/**
 * Longest edge kept when handing an image to a model.
 *
 * Anything larger is downscaled on the way in anyway, so sending more pixels
 * costs transfer and base64 overhead without adding detail.
 */
export const MAX_EDGE = 1568;

/** Ceiling on the bytes behind one returned image, before base64 expands it. */
export const MAX_IMAGE_BYTES = 3_500_000;

export function extensionOf(path: string): string {
  const cut = path.lastIndexOf('.');
  return cut === -1 ? '' : path.slice(cut + 1).toLowerCase();
}

export function isImagePath(path: string): boolean {
  const extension = extensionOf(path);
  return extension === 'svg' || extension in NATIVE_TYPES || extension in TRANSCODED_TYPES;
}

export function mimeTypeOf(path: string): string | undefined {
  const extension = extensionOf(path);
  if (extension === 'svg') return SVG_TYPE;
  return NATIVE_TYPES[extension] ?? TRANSCODED_TYPES[extension];
}

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Read pixel dimensions from a file header.
 *
 * Header parsing keeps listing a folder of attachments to one read per file
 * rather than one subprocess per file; `sips` is the fallback for the formats
 * not covered here.
 */
export function parseDimensions(head: Buffer): Dimensions | undefined {
  return parsePng(head) ?? parseGif(head) ?? parseWebp(head) ?? parseJpeg(head);
}

function parsePng(head: Buffer): Dimensions | undefined {
  if (head.length < 24) return undefined;
  if (head.readUInt32BE(0) !== 0x89504e47) return undefined;
  if (head.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function parseGif(head: Buffer): Dimensions | undefined {
  if (head.length < 10) return undefined;
  if (head.subarray(0, 3).toString('latin1') !== 'GIF') return undefined;
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
}

function parseWebp(head: Buffer): Dimensions | undefined {
  if (head.length < 30) return undefined;
  if (head.subarray(0, 4).toString('latin1') !== 'RIFF') return undefined;
  if (head.subarray(8, 12).toString('latin1') !== 'WEBP') return undefined;

  const chunk = head.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    return { width: readUInt24LE(head, 24) + 1, height: readUInt24LE(head, 27) + 1 };
  }
  if (chunk === 'VP8 ') {
    // The 14-bit dimensions sit just past the key-frame start code.
    if (head.readUIntLE(23, 3) !== 0x2a019d) return undefined;
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (head[20] !== 0x2f) return undefined;
    const bits = head.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer.readUIntLE(offset, 3);
}

function parseJpeg(head: Buffer): Dimensions | undefined {
  if (head.length < 4 || head.readUInt16BE(0) !== 0xffd8) return undefined;

  let offset = 2;
  while (offset + 9 < head.length) {
    if (head[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = head[offset + 1]!;
    // SOF0–SOF15 carry the frame size; C4/C8/CC are other things in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: head.readUInt16BE(offset + 7), height: head.readUInt16BE(offset + 5) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = head.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/** Dimensions from `sips`, for the formats no header parser here covers. */
export async function probeDimensions(path: string): Promise<Dimensions | undefined> {
  try {
    const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path]);
    const width = /pixelWidth:\s*(\d+)/.exec(stdout);
    const height = /pixelHeight:\s*(\d+)/.exec(stdout);
    if (width === null || height === null) return undefined;
    return { width: Number(width[1]), height: Number(height[1]) };
  } catch {
    return undefined;
  }
}

export interface PreparedImage {
  data: Buffer;
  mimeType: string;
  /** What had to be done to fit the budget, for the caller to report. */
  note?: string;
}

/**
 * Get an image into a form that can be returned to a model: a supported
 * format, within the pixel and byte budget.
 *
 * Conversion runs through `sips`, which ships with macOS — the daemon is a
 * personal service on one Mac, so that is one less native dependency to
 * build and keep current.
 */
export async function prepareImage(path: string, original: Dimensions | undefined, maxEdge: number): Promise<PreparedImage> {
  const extension = extensionOf(path);
  const native = NATIVE_TYPES[extension];
  const longestEdge = original === undefined ? undefined : Math.max(original.width, original.height);
  const oversized = longestEdge !== undefined && longestEdge > maxEdge;

  if (native !== undefined && !oversized) {
    const data = await readFile(path);
    if (data.byteLength <= MAX_IMAGE_BYTES) return { data, mimeType: native };
    // Within the pixel budget but still too many bytes: re-encode it down.
    return convert(path, Math.min(maxEdge, longestEdge ?? maxEdge), `re-encoded to fit ${MAX_IMAGE_BYTES} bytes`);
  }

  const reason =
    native === undefined
      ? `converted from ${extension.toUpperCase()} to PNG`
      : `downscaled from ${original!.width}×${original!.height}`;
  return convert(path, maxEdge, reason);
}

async function convert(path: string, maxEdge: number, reason: string): Promise<PreparedImage> {
  const directory = await mkdtemp(join(tmpdir(), 'portcall-image-'));
  try {
    let edge = maxEdge;
    let last: Buffer | undefined;
    // Three attempts: a photo that is huge in bytes rather than pixels needs
    // the edge cut further, and halving twice covers the realistic cases.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = join(directory, `image-${attempt}.png`);
      await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(edge), path, '--out', out]);
      last = await readFile(out);
      if (last.byteLength <= MAX_IMAGE_BYTES) {
        const suffix = attempt === 0 ? '' : `, longest edge ${edge}px`;
        return { data: last, mimeType: 'image/png', note: `${reason}${suffix}` };
      }
      edge = Math.max(320, Math.floor(edge / 2));
    }
    throw new Error(`Image is too large to return even downscaled: ${path}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Identify a format from its leading bytes.
 *
 * A name is not evidence: this is what stops an arbitrary blob being written
 * into the vault under an image extension.
 */
export function sniffFormat(bytes: Buffer): string | undefined {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avi')) return 'avif';
    if (brand.startsWith('hei') || brand.startsWith('mif') || brand.startsWith('msf')) return 'heic';
  }
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString('latin1') === 'BM') return 'bmp';
  if (bytes.length >= 4) {
    const order = bytes.subarray(0, 4);
    if (order.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || order.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) {
      return 'tiff';
    }
  }
  const text = bytes.subarray(0, 512).toString('utf8');
  if (/<svg[\s>]/i.test(text) || (text.trimStart().startsWith('<?xml') && /<svg/i.test(text))) return 'svg';
  return undefined;
}

/** The extension that belongs to a sniffed format, for reporting a mismatch. */
export function canonicalExtension(format: string): string {
  return format === 'jpeg' ? 'jpg' : format;
}
