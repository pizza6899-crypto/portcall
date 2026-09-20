import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Directories that hold nothing the vault is for.
 *
 * `.obsidian` is configuration, `.trash` is Obsidian's own recycle bin. A file
 * in either would show up as an orphan every time it was listed, and as a note
 * every time one was counted.
 */
const SKIPPED_DIRECTORIES = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

/**
 * Resolve a vault-relative path, refusing anything that leaves the vault.
 *
 * Absolute inputs and `..` segments both land outside, so both are rejected —
 * the mount serves one directory and nothing above it.
 */
export function insideVault(vaultPath: string, candidate: string): string {
  const root = resolve(vaultPath);
  const full = resolve(root, candidate);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes the vault: ${candidate}`);
  }
  return full;
}

/**
 * Whether a vault-relative path is the kind of file the vault is for.
 *
 * `walkVault` prunes the same two things as it descends — a directory on the
 * list above, and a dotfile — but a path that arrives as a string, from git
 * rather than from a traversal, has nothing to prune. Both read that one list
 * so the image tools and the history tools cannot come to disagree about what
 * counts as a note.
 */
export function isVaultContent(path: string): boolean {
  const segments = path.split('/');
  if ((segments[segments.length - 1] ?? '').startsWith('.')) return false;
  return !segments.slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

/** Every file in the vault, as paths relative to its root, in directory order. */
export async function walkVault(vaultPath: string): Promise<string[]> {
  const root = resolve(vaultPath);
  const found: string[] = [];

  async function descend(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !entry.isDirectory()) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await descend(join(directory, entry.name), rel);
      } else if (entry.isFile()) {
        found.push(rel);
      }
    }
  }

  await descend(root, '');
  return found;
}

/**
 * Targets of the image embeds in one note.
 *
 * Both Obsidian syntaxes count: `![[attachment.png]]` and `![alt](path.png)`.
 * Remote and inline sources are skipped — there is no vault file behind them.
 */
export function parseEmbeds(markdown: string): string[] {
  const targets: string[] = [];

  for (const match of markdown.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    // `target|alias` and `target#heading` both narrow a link to the same file.
    const target = match[1]!.split('|')[0]!.split('#')[0]!.trim();
    if (target !== '') targets.push(target);
  }

  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    // A title after the path (`(path "title")`) is not part of it.
    const raw = match[1]!.trim().split(/\s+/)[0]!;
    if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
    targets.push(decodeUriComponentSafely(raw));
  }

  return targets;
}

function decodeUriComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray `%` is a literal in Obsidian, not a broken escape.
    return value;
  }
}

/**
 * Resolve an embed target the way Obsidian does.
 *
 * A target containing a slash is a path from the vault root. A bare filename
 * is matched against every basename in the vault, which is why an ambiguous
 * one has to be reported rather than guessed at.
 */
export function resolveTarget(target: string, files: readonly string[]): string[] {
  const normalised = target.replace(/^\.\//, '');
  if (files.includes(normalised)) return [normalised];

  if (normalised.includes('/')) {
    const suffix = `/${normalised.toLowerCase()}`;
    return files.filter((file) => file.toLowerCase().endsWith(suffix));
  }

  const wanted = normalised.toLowerCase();
  return files.filter((file) => basename(file).toLowerCase() === wanted);
}

function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Extensions that make a frontmatter or canvas value worth resolving. */
const IMAGE_SUFFIX = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|heif|avif|ico)$/i;

/**
 * Image references in a note's frontmatter.
 *
 * Cover images, banners and thumbnail lists live here rather than in the
 * body, and a note that only names an image in its frontmatter still uses
 * it. This reads the block loosely rather than parsing YAML, so a filename
 * containing spaces can also yield a partial token — harmless, because the
 * result is only ever used to mark an image as referenced, never to report
 * a link as broken.
 */
export function frontmatterRefs(markdown: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (match === null) return [];

  // A remote address is not a vault file, and its path would match below.
  const block = match[1]!.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const found: string[] = [];

  for (const link of block.matchAll(/\[\[([^\]|#]+)/g)) found.push(link[1]!.trim());
  for (const quoted of block.matchAll(/["']([^"']+)["']/g)) found.push(quoted[1]!.trim());
  for (const bare of block.matchAll(/[^\s"'[\],]+/g)) found.push(bare[0].replace(/^[-:]+/, '').trim());

  return [...new Set(found.filter((value) => IMAGE_SUFFIX.test(value)))];
}

/**
 * Files an Obsidian canvas places on its board.
 *
 * A canvas is JSON with a `file` node per embedded file. One that will not
 * parse is skipped rather than failing the listing it is part of.
 */
export function canvasRefs(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const found: string[] = [];
  for (const node of nodes) {
    const file = (node as { file?: unknown }).file;
    if (typeof file === 'string' && file !== '') found.push(file);
  }
  return [...new Set(found)];
}
