import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

import { isImagePath } from './media.js';
import type { ExtraTool, ToolResult } from './merge.js';
import { insideVault, resolveTarget } from './paths.js';

const run = promisify(execFile);

/** How long one git invocation may run before it is given up on. */
const GIT_TIMEOUT_MS = 10_000;

/** Ceiling on what one git invocation may print. */
const GIT_MAX_BUFFER = 8_000_000;

/** Patch lines `note_diff` returns before it says it clipped. */
const MAX_PATCH_LINES = 400;

/** Characters of a note `note_at` returns. */
const MAX_NOTE_CHARS = 100_000;

export interface HistoryToolOptions {
  /** Absolute path to the vault, which is also the git work tree. */
  vaultPath: string;
}

function result(summary: string, data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

/**
 * Run one git command against the vault.
 *
 * `core.quotePath=false` is not optional here: by default git escapes any
 * path outside ASCII into octal, and the notes in this vault are Korean, so
 * every path would come back as `"\355\225\234..."` and match nothing.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps a read from taking the index lock. The vault
 * is snapshotted by a job on a timer, and a model asking what changed should
 * never be the reason that commit fails.
 */
async function git(vaultPath: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', vaultPath, '-c', 'core.quotePath=false', ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const detail = stderr.split('\n').find((line) => line.trim() !== '') ?? (error as Error).message;
    throw new Error(`git ${args[0] ?? ''} failed: ${detail}`);
  }
}

/** The same, for a command whose failure is an answer rather than a fault. */
async function tryGit(vaultPath: string, args: readonly string[]): Promise<string | undefined> {
  try {
    return await git(vaultPath, args);
  } catch {
    return undefined;
  }
}

function short(rev: string): string {
  return rev.slice(0, 9);
}

/** The newest snapshot, or a plain answer that there are none yet. */
async function headCommit(vaultPath: string): Promise<string> {
  const head = await tryGit(vaultPath, ['rev-parse', 'HEAD']);
  if (head === undefined || head.trim() === '') {
    throw new Error('The vault is a git repository but has no snapshots yet, so there is no history to read.');
  }
  return head.trim();
}

/** The hash of the empty tree, for comparing against "before anything existed". */
async function emptyTree(vaultPath: string): Promise<string> {
  return (await git(vaultPath, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

/** A point in the history: a commit, or a moment before the first one. */
interface Point {
  /** Undefined when the vault had no snapshot yet at this moment. */
  commit?: string;
  /** What the caller asked for, echoed back so the window is legible. */
  label: string;
  /** What git made of that, when it was read as a date rather than a revision. */
  resolved?: string;
}

/**
 * Resolve a revision, or the date of one.
 *
 * A value git knows as a commit is used as-is; anything else is read as a
 * date and answered with the newest snapshot at or before it.
 */
async function resolveRev(vaultPath: string, value: string): Promise<Point> {
  if (value.startsWith('-')) {
    throw new Error(`\`${value}\` cannot be a revision or a date: git would read it as an option.`);
  }

  const exact = await tryGit(vaultPath, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]);
  if (exact !== undefined && exact.trim() !== '') return { commit: exact.trim(), label: value };

  const resolved = new Date((await assertDate(vaultPath, value)) * 1000).toISOString();
  const at = (await git(vaultPath, ['rev-list', '-1', `--before=${value}`, 'HEAD'])).trim();
  return at === '' ? { label: value, resolved } : { commit: at, label: value, resolved };
}

/**
 * Refuse a date git cannot read.
 *
 * `--before=<value>` does not fail on a value git cannot parse — it falls
 * back to the current time. A typo would therefore be answered with "nothing
 * changed" rather than with the typo, which is the worst shape an error can
 * take. `rev-parse --since` prints what git actually made of the value, and
 * one it could not read comes back as now — which is how `지난주` and
 * `yesterdya` are caught here.
 *
 * What cannot be caught is a near miss git half-understands: `last tuseday`
 * becomes a real date, quietly. So the moment is returned and reported in the
 * answer, where a wrong reading is at least visible.
 */
async function assertDate(vaultPath: string, value: string): Promise<number> {
  const asked = Math.floor(Date.now() / 1000);
  const parsed = /--max-age=(\d+)/.exec(await git(vaultPath, ['rev-parse', `--since=${value}`]));
  if (parsed === null || Number(parsed[1]) >= asked - 2) {
    throw new Error(`Not a revision, and not a date git can read: \`${value}\`. Try \`2026-09-14\`, \`3 days ago\`, or a revision.`);
  }
  return Number(parsed[1]);
}

/** Non-empty lines, which is how git prints a list of paths. */
function lines(output: string): string[] {
  return output.split('\n').filter((line) => line.trim() !== '');
}

/** A note, as it is now or as it was. */
interface Located {
  path: string;
  /** False when the note is only in the history — renamed away or deleted. */
  tracked: boolean;
}

/**
 * Find the note a caller means.
 *
 * Exact vault-relative paths win. A bare name is resolved the way Obsidian
 * resolves a link, and a wiki link carries no extension, so `Daily/2026-09-20`
 * is also tried as `.md`. A name that matches nothing in the working tree is
 * looked for in the history too: a deleted note is exactly what someone asks
 * these tools about.
 */
async function locate(vaultPath: string, input: string): Promise<Located> {
  if (input.startsWith('-')) throw new Error(`\`${input}\` cannot be a path: git would read it as an option.`);
  insideVault(vaultPath, input);

  const candidate = input.replace(/^\.\//, '');
  const tracked = lines(await git(vaultPath, ['ls-files']));
  const here = pick(candidate, tracked);
  if (here !== undefined) return { path: here, tracked: true };

  // `--no-renames` on purpose: with rename detection only the new name is
  // printed, and the name being asked about is often the one that went away.
  const ever = lines(await git(vaultPath, ['log', '--pretty=format:', '--no-renames', '--name-only']));
  const gone = pick(candidate, [...new Set(ever)]);
  if (gone !== undefined) return { path: gone, tracked: false };

  throw new Error(`No note called \`${input}\` in the vault or anywhere in its history.`);
}

function pick(candidate: string, files: readonly string[]): string | undefined {
  for (const name of withMarkdown(candidate)) {
    const matches = resolveTarget(name, files);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`\`${candidate}\` matches ${matches.length} files: ${matches.join(', ')}. Give the vault-relative path.`);
    }
  }
  return undefined;
}

function withMarkdown(candidate: string): string[] {
  const base = candidate.slice(candidate.lastIndexOf('/') + 1);
  return base.includes('.') ? [candidate] : [candidate, `${candidate}.md`];
}

/**
 * Every name a note has had.
 *
 * A window that closes before a rename contains only the old name, so asking
 * for the note by the name it has today would answer "no change" for its
 * entire earlier life. `note_history` already follows renames; a diff that
 * did not would disagree with it.
 */
async function aliases(vaultPath: string, path: string): Promise<string[]> {
  const names = new Set([path]);
  for (const change of parseRaw(await git(vaultPath, ['log', '--follow', '-M', '--format=', '--raw', '--', path]))) {
    names.add(change.path);
    if (change.from !== undefined) names.add(change.from);
  }
  return [...names];
}

/**
 * The hunks of a patch, without the file headers.
 *
 * Dropping everything from `diff --git` to that section's first `@@` keeps
 * this correct where a blanket filter would not: a removed line of Obsidian
 * frontmatter reads as `----`, and a removed `-- x` reads as `--- x`, which
 * is exactly the shape of the header line being stripped. Inside a hunk
 * every line is kept, so neither can be mistaken for one.
 */
function hunks(patch: string): string[] {
  const kept: string[] = [];
  let inside = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inside = false;
      continue;
    }
    if (!inside && line.startsWith('@@ ')) inside = true;
    if (inside) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept;
}

type Status = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'changed';

interface Change {
  path: string;
  status: Status;
  /** The name it had before, when this is a rename. */
  from?: string;
}

function statusOf(letter: string): Status {
  switch (letter.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'changed';
  }
}

/**
 * The files a `--raw` block names.
 *
 * A raw line is `:<mode> <mode> <sha> <sha> <status>\t<path>[\t<newpath>]`,
 * which is where the status letter and both sides of a rename come from. It
 * is read rather than `--name-status` so that one call can carry the line
 * counts alongside it.
 */
function parseRaw(block: string): Change[] {
  const changes: Change[] = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith(':')) continue;
    const [meta, ...paths] = line.split('\t');
    const status = statusOf(meta?.trim().split(/\s+/).pop() ?? '');
    if ((status === 'renamed' || status === 'copied') && paths.length >= 2) {
      changes.push({ path: paths[1]!, status, from: paths[0]! });
    } else if (paths.length >= 1 && paths[0] !== undefined) {
      changes.push({ path: paths[0], status });
    }
  }
  return changes;
}

interface Counts {
  added?: number;
  removed?: number;
  /** git counts no lines in a binary file, and an attachment is one. */
  binary: boolean;
}

function parseNumstat(block: string): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line.trim() === '') continue;
    const [added, removed, ...rest] = line.split('\t');
    if (added === undefined || removed === undefined || rest.length === 0) continue;
    counts.set(
      numstatPath(rest.join('\t')),
      added === '-' ? { binary: true } : { added: Number(added), removed: Number(removed), binary: false },
    );
  }
  return counts;
}

/**
 * The path a numstat line refers to, after a rename.
 *
 * git prints `old => new`, and folds a shared prefix or suffix into braces:
 * `notes/{old.md => new.md}`. Only the new name is wanted — the old one is
 * already on the raw line beside it.
 */
function numstatPath(field: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
  const joined = braced === null ? field : `${braced[1]!}${braced[3]!}${braced[4]!}`;
  const arrow = joined.split(' => ');
  return (arrow.length === 2 ? arrow[1]! : joined).replace(/\/{2,}/g, '/').replace(/^\//, '');
}

/**
 * When each file was last touched in a range.
 *
 * git walks newest first, so the first block a path appears in is its most
 * recent change. Rename detection is off here so that a renamed note answers
 * to both of its names.
 */
function parseTouchTimes(output: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const block of output.split('\0')) {
    const rows = lines(block);
    const at = rows.shift();
    if (at === undefined) continue;
    for (const path of rows) if (!times.has(path)) times.set(path, at);
  }
  return times;
}

const changesSchema = z.object({
  since: z
    .string()
    .min(1)
    .describe('Start of the window: a date (`2026-09-14`), a relative one (`3 days ago`, `last monday`), or a revision.'),
  until: z.string().min(1).optional().describe('End of the window, in the same forms. Defaults to now.'),
  limit: z.number().int().min(1).max(500).optional().describe('Maximum rows per section. Defaults to 50.'),
});

/**
 * What changed in the vault over a window, as one figure per note.
 *
 * Deliberately not a list of commits. Snapshots are taken on a timer, so a
 * commit boundary is where the clock fell rather than where a thought ended:
 * one sitting is scattered over several commits, each of them titled
 * `snapshot <time>`. Listing them would show the same note four times and say
 * nothing. The window's two ends are compared instead, and `note_history` is
 * the tool that answers at commit resolution.
 */
function vaultChangesTool(options: HistoryToolOptions): ExtraTool<z.infer<typeof changesSchema>> {
  return {
    name: 'vault_changes',
    title: 'What changed in the vault',
    description:
      'Summarise what changed in the vault between two moments: one row per note with how much was added and removed, newest first. Takes dates (`2026-09-14`, `3 days ago`) or revisions. Use this for "what did I work on last week"; use note_history for one note.',
    schema: changesSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ since, until, limit = 50 }) => {
      const { vaultPath } = options;
      const head = await headCommit(vaultPath);
      const from = await resolveRev(vaultPath, since);
      const to = until === undefined ? { commit: head, label: 'now' } : await resolveRev(vaultPath, until);

      const window = {
        since: from.label,
        ...(from.resolved === undefined ? {} : { sinceResolved: from.resolved }),
        until: to.label,
        ...(to.resolved === undefined ? {} : { untilResolved: to.resolved }),
        from: from.commit === undefined ? null : short(from.commit),
        to: to.commit === undefined ? null : short(to.commit),
      };
      if (to.commit === undefined) {
        return result(`The vault had no snapshots yet at ${to.label}.`, { window, noteCount: 0, notes: [], attachments: [] });
      }

      const base = from.commit ?? (await emptyTree(vaultPath));
      const diff = await git(vaultPath, ['diff', '-M', '--raw', '--numstat', base, to.commit, '--']);
      const counts = parseNumstat(diff);
      const touched = parseTouchTimes(
        await git(vaultPath, [
          'log',
          '--no-renames',
          '--format=%x00%cI',
          '--name-only',
          ...(from.commit === undefined ? [to.commit] : [`${from.commit}..${to.commit}`]),
          '--',
        ]),
      );

      const notes: Record<string, unknown>[] = [];
      const attachments: Record<string, unknown>[] = [];
      for (const change of parseRaw(diff)) {
        const at = touched.get(change.path) ?? (change.from === undefined ? undefined : touched.get(change.from));
        const row: Record<string, unknown> = {
          path: change.path,
          status: change.status,
          ...(change.from === undefined ? {} : { from: change.from }),
          ...(at === undefined ? {} : { lastChanged: at }),
        };
        if (isImagePath(change.path)) {
          // An attachment has no lines to count, and a screenshot sitting in
          // the middle of a list of notes is what makes the list unreadable.
          attachments.push(row);
        } else {
          const count = counts.get(change.path);
          notes.push({ ...row, ...(count?.binary === false ? { added: count.added, removed: count.removed } : {}) });
        }
      }

      const byTime = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
        String(b['lastChanged'] ?? '').localeCompare(String(a['lastChanged'] ?? ''));
      notes.sort(byTime);
      attachments.sort(byTime);

      const counted = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
      const withFiles = attachments.length === 0 ? '' : ` and ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`;
      return result(`${counted}${withFiles} changed between ${from.label} and ${to.label}.`, {
        window,
        noteCount: notes.length,
        attachmentCount: attachments.length,
        notes: notes.slice(0, limit),
        attachments: attachments.slice(0, limit),
        ...(notes.length > limit || attachments.length > limit ? { truncated: true } : {}),
      });
    },
  };
}

const historySchema = z.object({
  path: z.string().min(1).describe('The note: a vault-relative path, or the name a link uses. A deleted note is found too.'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum snapshots to return, newest first. Defaults to 20.'),
});

/** Every snapshot that touched one note, through any renames. */
function noteHistoryTool(options: HistoryToolOptions): ExtraTool<z.infer<typeof historySchema>> {
  return {
    name: 'note_history',
    title: 'History of one note',
    description:
      'List the snapshots that changed one note, newest first, with when and how much. Follows the note through renames, and finds notes that were deleted. Pair with note_diff or note_at to see what a revision actually holds.',
    schema: historySchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ path: input, limit = 20 }) => {
      const { vaultPath } = options;
      await headCommit(vaultPath);
      const located = await locate(vaultPath, input);

      const output = await git(vaultPath, [
        'log',
        '--follow',
        '-M',
        `--max-count=${limit}`,
        '--format=%x00%H%x1f%cI',
        '--raw',
        '--numstat',
        '--',
        located.path,
      ]);

      const entries: Record<string, unknown>[] = [];
      for (const block of output.split('\0')) {
        if (block.trim() === '') continue;
        const cut = block.indexOf('\n');
        const header = (cut === -1 ? block : block.slice(0, cut)).split('\x1f');
        const body = cut === -1 ? '' : block.slice(cut + 1);
        const change = parseRaw(body)[0];
        const count = change === undefined ? undefined : parseNumstat(body).get(change.path);
        entries.push({
          rev: short(header[0] ?? ''),
          at: header[1] ?? '',
          status: change?.status ?? 'changed',
          ...(change?.from === undefined ? {} : { from: change.from }),
          ...(count === undefined || count.binary ? { binary: true } : { added: count.added, removed: count.removed }),
        });
      }

      const newest = entries[0]?.['at'];
      const oldest = entries[entries.length - 1]?.['at'];
      const span = entries.length === 0 ? '' : ` ${String(oldest).slice(0, 10)} → ${String(newest).slice(0, 10)}.`;
      const state = located.tracked ? '' : ' It is not in the vault now — renamed away or deleted.';
      return result(`${entries.length} snapshot${entries.length === 1 ? '' : 's'} touched \`${located.path}\`.${span}${state}`, {
        path: located.path,
        present: located.tracked,
        count: entries.length,
        entries,
      });
    },
  };
}

const diffSchema = z.object({
  path: z.string().min(1).describe('The note: a vault-relative path, or the name a link uses.'),
  from: z.string().min(1).describe('The earlier point: a revision from note_history, or a date.'),
  to: z.string().min(1).optional().describe('The later point, same forms. Defaults to now.'),
});

/** What changed in one note between two points. */
function noteDiffTool(options: HistoryToolOptions): ExtraTool<z.infer<typeof diffSchema>> {
  return {
    name: 'note_diff',
    title: 'Changes to one note',
    description:
      'Show the lines that changed in one note between two points in its history. Takes revisions from note_history or dates. Cheaper than reading the whole note twice when only the change matters.',
    schema: diffSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ path: input, from: fromInput, to: toInput }) => {
      const { vaultPath } = options;
      const head = await headCommit(vaultPath);
      const located = await locate(vaultPath, input);
      const from = await resolveRev(vaultPath, fromInput);
      const to = toInput === undefined ? { commit: head, label: 'now' } : await resolveRev(vaultPath, toInput);
      if (to.commit === undefined) {
        throw new Error(`The vault had no snapshots yet at ${to.label}.`);
      }

      const base = from.commit ?? (await emptyTree(vaultPath));
      const patch = await git(vaultPath, [
        'diff',
        '-M',
        '--unified=3',
        base,
        to.commit,
        '--',
        ...(await aliases(vaultPath, located.path)),
      ]);

      const body = hunks(patch);
      const kept = body.slice(0, MAX_PATCH_LINES);
      const added = body.filter((line) => line.startsWith('+')).length;
      const removed = body.filter((line) => line.startsWith('-')).length;

      const data = {
        path: located.path,
        from: from.commit === undefined ? null : short(from.commit),
        to: short(to.commit),
        added,
        removed,
        ...(body.length > kept.length ? { truncated: true } : {}),
      };

      if (body.length === 0) {
        const binary = patch.split('\n').some((line) => line.startsWith('Binary files'));
        const why = binary
          ? 'It is a binary file, so there are no lines to compare.'
          : `No change between ${from.label} and ${to.label}.`;
        return result(`\`${located.path}\`: ${why}`, data);
      }

      return {
        content: [
          {
            type: 'text',
            text: `\`${located.path}\`, ${from.label} → ${to.label}: +${added} −${removed}${data.truncated === true ? `, clipped at ${MAX_PATCH_LINES} lines` : ''}\n\n${kept.join('\n')}`,
          },
        ],
        structuredContent: data,
      };
    },
  };
}

const atSchema = z.object({
  path: z.string().min(1).describe('The note: a vault-relative path, or the name a link uses.'),
  rev: z.string().min(1).describe('Which point to read it at: a revision from note_history, or a date.'),
});

/** One note as it stood at a point in the history. */
function noteAtTool(options: HistoryToolOptions): ExtraTool<z.infer<typeof atSchema>> {
  return {
    name: 'note_at',
    title: 'A note as it was',
    description:
      'Return the full text of a note as it stood at a revision or date. This is also how a deleted or overwritten note is recovered: read it here, then write it back with write_note.',
    schema: atSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ path: input, rev }) => {
      const { vaultPath } = options;
      await headCommit(vaultPath);
      const located = await locate(vaultPath, input);
      if (isImagePath(located.path)) {
        throw new Error(`\`${located.path}\` is an attachment, not a note. read_image returns the one in the vault now.`);
      }

      const at = await resolveRev(vaultPath, rev);
      if (at.commit === undefined) throw new Error(`The vault had no snapshots yet at ${at.label}.`);

      const text = await tryGit(vaultPath, ['show', `${at.commit}:${located.path}`]);
      if (text === undefined) {
        throw new Error(`\`${located.path}\` did not exist at ${short(at.commit)}. note_history shows when it appeared, and under which name.`);
      }

      const clipped = text.length > MAX_NOTE_CHARS;
      const data = {
        path: located.path,
        rev: short(at.commit),
        chars: text.length,
        ...(clipped ? { truncated: true } : {}),
      };
      return {
        content: [
          {
            type: 'text',
            text: `\`${located.path}\` at ${short(at.commit)}${clipped ? `, first ${MAX_NOTE_CHARS} characters` : ''}:\n\n${clipped ? text.slice(0, MAX_NOTE_CHARS) : text}`,
          },
        ],
        structuredContent: data,
      };
    },
  };
}

/**
 * Read-only history tools over the vault's own git repository.
 *
 * Nothing here writes: recovering a note is `note_at` followed by the vault's
 * existing `write_note`, which keeps the restore visible as an ordinary edit
 * rather than adding a tool that reaches into git.
 *
 * A vault that is not a repository gets no tools at all, the way the KIS
 * mount serves quotations only until an account is configured — a listed tool
 * that always fails is worse than one that was never listed.
 */
export function historyTools(options: HistoryToolOptions): ExtraTool<never>[] {
  if (!existsSync(join(options.vaultPath, '.git'))) return [];
  const tools: unknown[] = [
    vaultChangesTool(options),
    noteHistoryTool(options),
    noteDiffTool(options),
    noteAtTool(options),
  ];
  return tools as ExtraTool<never>[];
}
