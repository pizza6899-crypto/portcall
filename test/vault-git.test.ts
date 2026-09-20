import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { createServer } from '@bitbonsai/mcpvault';

import { historyTools } from '../src/plugins/vault/git.js';
import { mergeTools } from '../src/plugins/vault/merge.js';

interface Content {
  type: string;
  text?: string;
}

interface Harness {
  names: () => Promise<string[]>;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; data: any; isError: boolean }>;
  close: () => Promise<void>;
}

/**
 * Drive the merged server over a linked transport pair.
 *
 * The tools are exercised through `tools/call` rather than as functions, so
 * the schema validation and the error shaping are covered too — a thrown
 * error is supposed to reach the caller as tool output, not as a fault.
 */
async function openHarness(vaultPath: string): Promise<Harness> {
  const server = mergeTools(() => createServer(vaultPath, { readOnly: true }), historyTools({ vaultPath }), {
    name: 'portcall-test',
    version: '0',
  });

  const [near, far] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: Record<string, any>) => void>();
  near.onmessage = (message: any) => {
    const settle = pending.get(message.id);
    if (settle !== undefined) {
      pending.delete(message.id);
      settle(message);
    }
  };
  await server.connect(far);
  await near.start();

  let id = 0;
  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      void near.send({ jsonrpc: '2.0', id, method, params } as any);
    });

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);

  return {
    names: async () => ((await rpc('tools/list', {}))['result'].tools as { name: string }[]).map((t) => t.name),
    call: async (name, args = {}) => {
      const response = await rpc('tools/call', { name, arguments: args });
      assert.equal(response['error'], undefined, `tools/call ${name} failed at the protocol level`);
      const payload = response['result'];
      return {
        text: (payload.content as Content[]).map((part) => part.text ?? `[${part.type}]`).join('\n'),
        data: payload.structuredContent,
        isError: payload.isError === true,
      };
    },
    close: async () => {
      await near.close();
      await server.close();
    },
  };
}

let vault: string;
let plain: string;
let harness: Harness;

/** Commit everything, at a fixed moment: `rev-list --before` reads committer dates. */
async function snapshot(at: string, message: string): Promise<void> {
  await run('git', ['-C', vault, 'add', '-A']);
  await run('git', ['-C', vault, 'commit', '-q', '-m', message], {
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
}

before(async () => {
  vault = await mkdtemp(join(tmpdir(), 'portcall-history-'));
  plain = await mkdtemp(join(tmpdir(), 'portcall-nogit-'));
  await writeFile(join(plain, 'note.md'), '# Plain\n');

  await run('git', ['-C', vault, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', vault, 'config', 'user.email', 'test@example.invalid']);
  await run('git', ['-C', vault, 'config', 'user.name', 'portcall test']);

  // A Korean name with a space in it: git escapes both by default, and the
  // real vault is full of them.
  await mkdir(join(vault, '노트'), { recursive: true });
  await mkdir(join(vault, 'attachments'), { recursive: true });
  // Long enough that later edits stay inside git's 50% similarity threshold:
  // a three-line note grown to five is a delete and an add, not a rename.
  await writeFile(join(vault, '노트', '한글 노트.md'), '# 한글\n\n첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄\n');
  await writeFile(join(vault, 'daily.md'), '# Daily\n\nuntouched\n');
  await snapshot('2026-09-01T10:00:00+09:00', 'snapshot 2026-09-01 10:00 — 2 file(s)');

  await writeFile(join(vault, '노트', '한글 노트.md'), '# 한글\n\n첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄\n여섯째 줄\n');
  // NUL bytes make git call it binary, which is what an attachment is.
  await writeFile(join(vault, 'attachments', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await snapshot('2026-09-05T10:00:00+09:00', 'snapshot 2026-09-05 10:00 — 2 file(s)');

  await writeFile(
    join(vault, '노트', '한글 노트.md'),
    '# 한글\n\n첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄\n여섯째 줄\n일곱째 줄\n',
  );
  await snapshot('2026-09-10T10:00:00+09:00', 'snapshot 2026-09-10 10:00 — 1 file(s)');

  await run('git', ['-C', vault, 'mv', '노트/한글 노트.md', '노트/새 이름.md']);
  await snapshot('2026-09-12T10:00:00+09:00', 'snapshot 2026-09-12 10:00 — 1 file(s)');

  await writeFile(join(vault, '버릴것.md'), '# 버릴것\n\n지워질 내용\n');
  await snapshot('2026-09-15T10:00:00+09:00', 'snapshot 2026-09-15 10:00 — 1 file(s)');

  await unlink(join(vault, '버릴것.md'));
  await snapshot('2026-09-16T10:00:00+09:00', 'snapshot 2026-09-16 10:00 — 1 file(s)');

  harness = await openHarness(vault);
});

after(async () => {
  await harness.close();
  await rm(vault, { recursive: true, force: true });
  await rm(plain, { recursive: true, force: true });
});

describe('history tools', () => {
  test('are listed alongside the vault ones', async () => {
    const names = await harness.names();
    for (const tool of ['vault_changes', 'note_history', 'note_diff', 'note_at']) {
      assert.ok(names.includes(tool), `${tool} missing from the listing`);
    }
    assert.ok(names.includes('read_note'), 'the upstream tools should still be there');
  });

  test('are absent when the vault is not a repository', async () => {
    assert.deepEqual(historyTools({ vaultPath: plain }), []);
  });
});

describe('vault_changes', () => {
  test('reports a Korean path unescaped', async () => {
    const { data } = await harness.call('vault_changes', { since: '2026-09-04' });
    const paths = data.notes.map((note: { path: string }) => note.path);
    assert.ok(paths.includes('노트/새 이름.md'), `expected the Korean path, got ${JSON.stringify(paths)}`);
  });

  test('aggregates the window rather than listing snapshots', async () => {
    const { data } = await harness.call('vault_changes', { since: '2026-09-02' });
    // The note was touched by four snapshots in that window. It is one row.
    const rows = data.notes.filter((note: { path: string }) => note.path === '노트/새 이름.md');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'renamed');
    assert.equal(rows[0].from, '노트/한글 노트.md');
    assert.equal(rows[0].added, 2);
    assert.equal(rows[0].removed, 0);
  });

  test('leaves out a note that came and went inside the window', async () => {
    const { data } = await harness.call('vault_changes', { since: '2026-09-14' });
    const paths = data.notes.map((note: { path: string }) => note.path);
    assert.ok(!paths.includes('버릴것.md'), 'added then deleted nets to no change');
  });

  test('leaves out a note nothing touched', async () => {
    const { data } = await harness.call('vault_changes', { since: '2026-09-04' });
    const paths = data.notes.map((note: { path: string }) => note.path);
    assert.ok(!paths.includes('daily.md'));
  });

  test('keeps attachments out of the note rows', async () => {
    const { data } = await harness.call('vault_changes', { since: '2026-09-04' });
    assert.deepEqual(
      data.notes.map((note: { path: string }) => note.path).filter((path: string) => path.endsWith('.png')),
      [],
    );
    assert.equal(data.attachments[0].path, 'attachments/shot.png');
    assert.equal(data.attachments[0].added, undefined, 'a binary file has no lines to count');
  });

  test('sorts by when each note was last touched', async () => {
    const { data } = await harness.call('vault_changes', { since: '2026-09-02' });
    const times = data.notes.map((note: { lastChanged: string }) => note.lastChanged);
    assert.deepEqual([...times].sort().reverse(), times);
  });

  test('treats a start before the first snapshot as the empty vault', async () => {
    const { data } = await harness.call('vault_changes', { since: '2026-01-01' });
    assert.equal(data.window.from, null);
    const statuses = new Set(data.notes.map((note: { status: string }) => note.status));
    assert.deepEqual([...statuses], ['added']);
  });

  test('refuses a date git cannot read instead of answering with now', async () => {
    const { text, isError } = await harness.call('vault_changes', { since: '지난주' });
    assert.ok(isError, 'a date git cannot read must not come back as "nothing changed"');
    assert.match(text, /not a date git can read/i);
  });

  test('accepts a relative date', async () => {
    const { isError } = await harness.call('vault_changes', { since: '3 days ago' });
    assert.equal(isError, false);
  });

  test('says what it made of the date it was given', async () => {
    const { data } = await harness.call('vault_changes', { since: '2026-09-02' });
    // git reads a near miss like `last tuseday` as a real date rather than
    // failing, so the only defence left is showing what it read.
    assert.match(data.window.sinceResolved, /^2026-09-02T/);
  });
});

describe('note_history', () => {
  test('follows a note through its rename', async () => {
    const { data } = await harness.call('note_history', { path: '노트/새 이름.md' });
    assert.equal(data.present, true);
    assert.equal(data.count, 4, 'created, edited twice, renamed');
    assert.equal(data.entries[0].status, 'renamed');
    assert.equal(data.entries[0].from, '노트/한글 노트.md');
    assert.equal(data.entries[3].status, 'added');
    assert.equal(data.entries[3].added, 7);
  });

  test('resolves the name a link would use', async () => {
    const { data } = await harness.call('note_history', { path: '새 이름' });
    assert.equal(data.path, '노트/새 이름.md');
  });

  test('finds a note that is no longer in the vault', async () => {
    const { data } = await harness.call('note_history', { path: '버릴것.md' });
    assert.equal(data.present, false);
    assert.equal(data.count, 2);
    assert.equal(data.entries[0].status, 'deleted');
  });

  test('refuses a path that climbs out of the vault', async () => {
    const { text, isError } = await harness.call('note_history', { path: '../../etc/hosts' });
    assert.ok(isError);
    assert.match(text, /escapes the vault/i);
  });

  test('refuses a name that would read as an option', async () => {
    const { isError } = await harness.call('note_history', { path: '--output=/tmp/x' });
    assert.ok(isError);
  });
});

describe('note_diff', () => {
  test('returns the hunks without the file header', async () => {
    const { text, data } = await harness.call('note_diff', {
      path: '새 이름',
      from: '2026-09-04',
      to: '2026-09-11',
    });
    assert.ok(!text.includes('diff --git'), 'the header is noise, the path is already in the answer');
    assert.ok(text.includes('+여섯째 줄'));
    assert.ok(text.includes('+일곱째 줄'));
    assert.equal(data.added, 2);
    assert.equal(data.removed, 0);
  });

  test('reads a window that closes before the note was renamed', async () => {
    const { data } = await harness.call('note_diff', {
      path: '새 이름',
      from: '2026-09-02',
      to: '2026-09-11',
    });
    assert.equal(data.added, 2, 'the note was called 한글 노트.md for all of that window');
  });

  test('says so when nothing changed in the window', async () => {
    const { text } = await harness.call('note_diff', { path: 'daily.md', from: '2026-09-04', to: '2026-09-11' });
    assert.match(text, /No change/i);
  });
});

describe('note_at', () => {
  test('returns a deleted note as it stood', async () => {
    const { text } = await harness.call('note_at', { path: '버릴것.md', rev: '2026-09-15T12:00:00+09:00' });
    assert.ok(text.includes('지워질 내용'), `expected the note body, got: ${text}`);
  });

  test('points at read_image for an attachment', async () => {
    const { text, isError } = await harness.call('note_at', { path: 'attachments/shot.png', rev: 'HEAD' });
    assert.ok(isError);
    assert.match(text, /read_image/);
  });

  test('says when the note did not exist yet at that point', async () => {
    const { text, isError } = await harness.call('note_at', { path: '버릴것.md', rev: '2026-09-02T00:00:00+09:00' });
    assert.ok(isError);
    assert.match(text, /did not exist/i);
  });
});
