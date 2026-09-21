import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync, crc32 } from 'node:zlib';

const run = promisify(execFile);

import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { createServer } from '@bitbonsai/mcpvault';

import { imageTools } from '../src/plugins/vault/image.js';
import { mergeTools } from '../src/plugins/vault/merge.js';

/** A real, decodable PNG — `sips` has to be able to open it to resize it. */
function png(width: number, height: number): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3;
      raw[at] = (x * 7) % 256;
      raw[at + 1] = (y * 5) % 256;
      raw[at + 2] = 128;
    }
  }

  const chunk = (type: string, body: Buffer): Buffer => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.byteLength);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, checksum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Content {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface Harness {
  names: () => Promise<string[]>;
  call: (name: string, args?: Record<string, unknown>) => Promise<Content[]>;
  text: (name: string, args?: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Drive the merged server over a linked transport pair.
 *
 * The tools are exercised through `tools/call` rather than as functions, so
 * the proxying and the schema validation are covered too.
 */
async function openHarness(
  vaultPath: string,
  options: { readOnly?: boolean; importRoots?: readonly string[] } = {},
): Promise<Harness> {
  const readOnly = options.readOnly ?? false;
  const server = mergeTools(
    () => createServer(vaultPath, { readOnly }),
    imageTools({ vaultPath, readOnly, importRoots: options.importRoots ?? [] }),
    { name: 'portcall-test', version: '0' },
  );

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

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Content[]> => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response['error'], undefined, `tools/call ${name} failed at the protocol level`);
    return response['result'].content as Content[];
  };

  return {
    names: async () => ((await rpc('tools/list', {}))['result'].tools as { name: string }[]).map((t) => t.name),
    call,
    text: async (name, args) => (await call(name, args)).map((part) => part.text ?? `[${part.type}]`).join('\n'),
    close: async () => {
      await near.close();
      await server.close();
    },
  };
}

let vault: string;
let outside: string;

before(async () => {
  vault = await mkdtemp(join(tmpdir(), 'portcall-images-'));
  outside = await mkdtemp(join(tmpdir(), 'portcall-import-'));

  await mkdir(join(vault, 'attachments'), { recursive: true });
  await writeFile(join(vault, 'attachments', 'wide.png'), png(2000, 100));
  await writeFile(join(vault, 'small.png'), png(40, 30));
  await writeFile(join(vault, 'orphan.png'), png(8, 8));
  await mkdir(join(vault, 'a'), { recursive: true });
  await mkdir(join(vault, 'b'), { recursive: true });
  await writeFile(join(vault, 'a', 'twin.png'), png(8, 8));
  await writeFile(join(vault, 'b', 'twin.png'), png(8, 8));
  await writeFile(join(vault, 'shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
  await writeFile(join(vault, 'note.md'), '# Note\n\n![[wide.png]]\n\n![cap](small.png)\n\n![[gone.png]]\n');
  await writeFile(join(vault, 'other.md'), 'See ![[wide.png]]\n');

  await writeFile(join(outside, 'desktop.png'), png(12, 12));
  await writeFile(join(outside, 'secret.png'), png(12, 12));

  // A photo, as a JPEG, big enough that returning it means re-encoding it.
  await writeFile(join(outside, 'source.png'), png(2400, 1800));
  await run('/usr/bin/sips', [
    '-s', 'format', 'jpeg', '-s', 'formatOptions', '90',
    join(outside, 'source.png'), '--out', join(vault, 'photo.jpg'),
  ]);

  // A JPEG whose dimensions sit past the first kilobyte, the way a photo with
  // an embedded EXIF thumbnail does. The padding is an APP1 segment, which a
  // decoder skips and a header parser has to walk over to reach the SOF.
  const photo = await readFile(join(vault, 'photo.jpg'));
  const padding = Buffer.alloc(4000);
  padding.writeUInt16BE(0xffe1, 0);
  padding.writeUInt16BE(padding.byteLength - 2, 2);
  await writeFile(join(vault, 'padded.jpg'), Buffer.concat([photo.subarray(0, 2), padding, photo.subarray(2)]));

  // A real TIFF, for the extension the write path used to refuse.
  await run('/usr/bin/sips', ['-s', 'format', 'tiff', join(outside, 'source.png'), '--out', join(outside, 'scan.tif')]);

  // Frontmatter and canvas references, each the only use of its image.
  await writeFile(join(vault, 'covered.png'), png(8, 8));
  await writeFile(join(vault, 'boarded.png'), png(8, 8));
  await writeFile(join(vault, 'cover.md'), '---\ncover: covered.png\n---\n\nNo embed in the body.\n');
  await writeFile(
    join(vault, 'board.canvas'),
    JSON.stringify({ nodes: [{ id: '1', type: 'file', file: 'boarded.png' }], edges: [] }),
  );
});

after(async () => {
  await rm(vault, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('merging with mcpvault', () => {
  test('serves the upstream tools and the image tools together', async () => {
    const harness = await openHarness(vault);
    try {
      const names = await harness.names();
      assert.ok(names.includes('read_note'), 'upstream tools survive the merge');
      assert.ok(names.includes('write_note'));
      for (const added of ['read_image', 'find_images', 'write_image']) {
        assert.ok(names.includes(added), `${added} is listed`);
      }
      assert.equal(new Set(names).size, names.length, 'no tool name is served twice');
    } finally {
      await harness.close();
    }
  });

  test('still routes a call to the upstream server', async () => {
    const harness = await openHarness(vault);
    try {
      const stats = await harness.text('get_vault_stats');
      // mcpvault's own payload, so the call plainly reached it.
      assert.match(stats, /"notes":\s*\d+/);
      assert.match(stats, /"folders":\s*\d+/);
    } finally {
      await harness.close();
    }
  });

  test('a read-only mount offers no way to write an image', async () => {
    const harness = await openHarness(vault, { readOnly: true });
    try {
      const names = await harness.names();
      assert.ok(names.includes('read_image'));
      assert.ok(names.includes('find_images'));
      assert.ok(!names.includes('write_image'), 'write_image is withheld');
    } finally {
      await harness.close();
    }
  });
});

describe('an upstream that goes away', () => {
  /** A server that drops the link instead of answering, the way a crash would. */
  function deserter(): Server {
    const server = new Server({ name: 'deserter', version: '0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => {
      await server.close();
      // Never settles: the only way out is the transport closing.
      return new Promise<never>(() => undefined);
    });
    return server;
  }

  /**
   * Two calls: the first kills the link, the second is sent down a link that
   * is already gone. The second is where `send` itself throws.
   */
  async function drive(): Promise<Record<string, any>[]> {
    const merged = mergeTools(deserter, [], { name: 'portcall-test', version: '0' });
    const [near, far] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, (message: Record<string, any>) => void>();
    near.onmessage = (message: any) => {
      const settle = pending.get(message.id);
      if (settle !== undefined) {
        pending.delete(message.id);
        settle(message);
      }
    };
    await merged.connect(far);
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

    const settled = async (): Promise<Record<string, any>> =>
      Promise.race([
        rpc('tools/list', {}),
        new Promise<Record<string, any>>((resolve) => setTimeout(() => resolve({ hung: true }), 2000)),
      ]);

    const answers = [await settled(), await settled()];
    await near.close().catch(() => undefined);
    return answers;
  }

  test('a dropped link fails the call rather than hanging the request', async () => {
    // Before this was handled the call sat in a Promise with no reject path,
    // so the HTTP request behind it never answered at all.
    for (const [index, answered] of (await drive()).entries()) {
      assert.equal(answered['hung'], undefined, `call ${index + 1} came back instead of hanging`);
      assert.notEqual(answered['error'], undefined, `call ${index + 1} came back as a failure`);
    }
  });

  test('a transport failure never escapes as an unhandled rejection', async () => {
    // `send` throws once the transport is closed, and the rejection used to be
    // discarded with `void`. Node's default for an unhandled rejection is to
    // exit, so that one line could take the daemon down with the request.
    const escaped: unknown[] = [];
    const watch = (error: unknown): void => {
      escaped.push(error);
    };
    process.on('unhandledRejection', watch);
    try {
      await drive();
      // Rejections surface on a later turn of the loop than the call itself.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('unhandledRejection', watch);
    }
    assert.deepEqual(escaped, [], 'nothing reached the process-level handler');
  });
});

describe('what a write leaves behind', () => {
  test('a missing embed target stops the write instead of half-doing it', async () => {
    // The image used to be written first, so the caller was told the embed
    // failed and never told a file had appeared — and the corrected retry
    // then hit "already exists" for a file it did not know it had made.
    const scratch = await mkdtemp(join(tmpdir(), 'portcall-halfway-'));
    const harness = await openHarness(scratch);
    try {
      const parts = await harness.call('write_image', {
        path: 'shot.png',
        data: png(4, 4).toString('base64'),
        embedIn: 'no-such-note',
      });
      assert.match(parts.map((part) => part.text ?? '').join('\n'), /No note to embed into/);
      await assert.rejects(() => access(join(scratch, 'shot.png')), 'nothing was left in the vault');
    } finally {
      await harness.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('an edit made while the image was downloading is not overwritten', async () => {
    // The note is read to prove it is there before a byte is written, which is
    // what the test above pins. Holding on to that read and writing it back
    // afterwards is a different thing: a URL import waits on the network, and
    // anything typed into the note in the meantime was silently discarded.
    const scratch = await mkdtemp(join(tmpdir(), 'portcall-race-'));
    const note = join(scratch, 'racing.md');
    await writeFile(note, '# Racing\n\nwritten before the call\n');

    const harness = await openHarness(scratch);
    const realFetch = globalThis.fetch;
    // An IP literal so the SSRF check resolves it without touching a resolver.
    globalThis.fetch = (async () => {
      // Stands in for an Obsidian autosave landing mid-download.
      await writeFile(note, '# Racing\n\nwritten before the call\nwritten during the download\n');
      return new Response(png(8, 8), { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;

    try {
      const summary = await harness.text('write_image', {
        path: 'raced.png',
        url: 'http://93.184.216.34/raced.png',
        embedIn: 'racing.md',
      });
      assert.match(summary, /^Wrote raced\.png/);

      const after = await readFile(note, 'utf8');
      assert.match(after, /written during the download/, 'the concurrent edit survives');
      assert.match(after, /!\[\[raced\.png\]\]/, 'and the embed is appended to it');
    } finally {
      globalThis.fetch = realFetch;
      await harness.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a write leaves no staging file behind', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'portcall-staging-'));
    const harness = await openHarness(scratch);
    try {
      await harness.call('write_image', { path: 'shot.png', data: png(4, 4).toString('base64') });
      const left = await readdir(scratch);
      assert.deepEqual(left.filter((name) => name.endsWith('.tmp')), [], 'the file is renamed into place, not left aside');
      assert.deepEqual(left, ['shot.png']);
    } finally {
      await harness.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a TIFF may be saved as .tif, which is what a TIFF is called', async () => {
    // `.tif` is in the set the vault stores, but the write check compared the
    // sniffed format to one canonical spelling and refused the other.
    const scratch = await mkdtemp(join(tmpdir(), 'portcall-tif-'));
    const harness = await openHarness(scratch);
    try {
      const tiff = await readFile(join(outside, 'scan.tif'));
      const parts = await harness.call('write_image', { path: 'scan.tif', data: tiff.toString('base64') });
      assert.match(parts.map((part) => part.text ?? '').join('\n'), /Wrote scan\.tif/);
      await access(join(scratch, 'scan.tif'));
    } finally {
      await harness.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('bytes that do not match the extension are still refused', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'portcall-mismatch-'));
    const harness = await openHarness(scratch);
    try {
      const parts = await harness.call('write_image', { path: 'shot.jpg', data: png(4, 4).toString('base64') });
      assert.match(parts.map((part) => part.text ?? '').join('\n'), /data is PNG but the path ends in \.jpg/);
    } finally {
      await harness.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('read_image', () => {
  test('returns an image a model can actually look at', async () => {
    const harness = await openHarness(vault);
    try {
      const parts = await harness.call('read_image', { path: 'small.png' });
      const image = parts.find((part) => part.type === 'image');
      assert.ok(image !== undefined, 'an image block comes back');
      assert.equal(image.mimeType, 'image/png');
      assert.ok((image.data ?? '').length > 0);
      assert.match(parts.find((part) => part.type === 'text')?.text ?? '', /40×30/);
    } finally {
      await harness.close();
    }
  });

  test('downscales an oversized image and says that it did', async () => {
    const harness = await openHarness(vault);
    try {
      const parts = await harness.call('read_image', { path: 'wide.png', maxEdge: 200 });
      assert.ok(parts.some((part) => part.type === 'image'));
      assert.match(parts.find((part) => part.type === 'text')?.text ?? '', /downscaled from 2000×100/);
    } finally {
      await harness.close();
    }
  });

  test('hands back SVG as its source', async () => {
    const harness = await openHarness(vault);
    try {
      const parts = await harness.call('read_image', { path: 'shape.svg' });
      assert.ok(!parts.some((part) => part.type === 'image'), 'markup is not sent as a bitmap');
      assert.match(parts[0]?.text ?? '', /<svg/);
    } finally {
      await harness.close();
    }
  });

  test('says where to look when the name matches nothing', async () => {
    const harness = await openHarness(vault);
    try {
      assert.match(await harness.text('read_image', { path: 'nope.png' }), /No image matches .*find_images/s);
    } finally {
      await harness.close();
    }
  });

  test('refuses to guess between two files with the same name', async () => {
    const harness = await openHarness(vault);
    try {
      const message = await harness.text('read_image', { path: 'twin.png' });
      assert.match(message, /matches 2 images/);
      assert.match(message, /a\/twin\.png/);
      assert.match(message, /b\/twin\.png/);
    } finally {
      await harness.close();
    }
  });

  test('will not read its way out of the vault', async () => {
    const harness = await openHarness(vault);
    try {
      assert.match(await harness.text('read_image', { path: '../../etc/hosts' }), /^Error:/);
    } finally {
      await harness.close();
    }
  });
});

describe('find_images', () => {
  test('a JPEG whose size sits past the first kilobyte is still measured', async () => {
    // A listing read 1024 bytes and gave up. A photo carrying an EXIF
    // thumbnail keeps its SOF marker well past that, so those images were
    // listed with no dimensions at all while read_image reported them fine.
    const harness = await openHarness(vault);
    try {
      const listed = await harness.text('find_images', { query: 'padded' });
      const row = JSON.parse(listed.slice(listed.indexOf('{'))).images[0];
      assert.equal(row.path, 'padded.jpg');
      assert.equal(row.width, 2400);
      assert.equal(row.height, 1800);
    } finally {
      await harness.close();
    }
  });

  test('lists images with the notes that embed them', async () => {
    const harness = await openHarness(vault);
    try {
      const listing = await harness.text('find_images');
      assert.match(listing, /"path": "attachments\/wide\.png"/);
      assert.match(listing, /"note\.md"/);
      assert.match(listing, /"other\.md"/);
      assert.match(listing, /"width": 2000/);
    } finally {
      await harness.close();
    }
  });

  test('finds the images nothing links to', async () => {
    const harness = await openHarness(vault);
    try {
      const listing = await harness.text('find_images', { status: 'orphan' });
      assert.match(listing, /orphan\.png/);
      assert.ok(!listing.includes('attachments/wide.png'), 'an embedded image is not an orphan');
    } finally {
      await harness.close();
    }
  });

  test('finds the embeds with no file behind them', async () => {
    const harness = await openHarness(vault);
    try {
      const listing = await harness.text('find_images', { status: 'broken' });
      assert.match(listing, /"embed": "gone\.png"/);
      assert.match(listing, /"inNote": "note\.md"/);
    } finally {
      await harness.close();
    }
  });

  test('filters by folder and by name', async () => {
    const harness = await openHarness(vault);
    try {
      const byFolder = await harness.text('find_images', { folder: 'attachments' });
      assert.match(byFolder, /"matched": 1/);
      const byName = await harness.text('find_images', { query: 'twin' });
      assert.match(byName, /"matched": 2/);
    } finally {
      await harness.close();
    }
  });
});

describe('write_image', () => {
  test('writes a file and embeds it in a note', async () => {
    const harness = await openHarness(vault);
    try {
      const summary = await harness.text('write_image', {
        path: 'attachments/added.png',
        data: png(20, 10).toString('base64'),
        embedIn: 'note.md',
      });
      assert.match(summary, /Wrote attachments\/added\.png/);

      const written = await readFile(join(vault, 'attachments', 'added.png'));
      assert.equal(written.byteLength > 0, true);
      assert.match(await readFile(join(vault, 'note.md'), 'utf8'), /!\[\[added\.png\]\]/);
    } finally {
      await harness.close();
    }
  });

  test('refuses bytes that are not an image', async () => {
    const harness = await openHarness(vault);
    try {
      const message = await harness.text('write_image', {
        path: 'attachments/fake.png',
        data: Buffer.from('#!/bin/sh\nrm -rf /\n').toString('base64'),
      });
      assert.match(message, /not a recognised image format/);
    } finally {
      await harness.close();
    }
  });

  test('refuses an extension that contradicts the bytes', async () => {
    const harness = await openHarness(vault);
    try {
      const message = await harness.text('write_image', {
        path: 'attachments/mislabelled.jpg',
        data: png(4, 4).toString('base64'),
      });
      assert.match(message, /is PNG but the path ends in \.jpg/);
    } finally {
      await harness.close();
    }
  });

  test('will not overwrite without being told to', async () => {
    const harness = await openHarness(vault);
    try {
      const args = { path: 'attachments/once.png', data: png(4, 4).toString('base64') };
      assert.match(await harness.text('write_image', args), /^Wrote/);
      assert.match(await harness.text('write_image', args), /already exists/);
      assert.match(await harness.text('write_image', { ...args, overwrite: true }), /^Wrote/);
    } finally {
      await harness.close();
    }
  });

  test('will not write outside the vault', async () => {
    const harness = await openHarness(vault);
    try {
      const message = await harness.text('write_image', {
        path: '../escaped.png',
        data: png(4, 4).toString('base64'),
      });
      assert.match(message, /escapes the vault/);
    } finally {
      await harness.close();
    }
  });

  test('needs exactly one source', async () => {
    const harness = await openHarness(vault);
    try {
      assert.match(await harness.text('write_image', { path: 'attachments/x.png' }), /exactly one of/);
      assert.match(
        await harness.text('write_image', {
          path: 'attachments/x.png',
          data: png(4, 4).toString('base64'),
          url: 'https://example.com/x.png',
        }),
        /exactly one of/,
      );
    } finally {
      await harness.close();
    }
  });

  test('imports a local file only from an allowed folder', async () => {
    const harness = await openHarness(vault, { importRoots: [outside] });
    try {
      assert.match(
        await harness.text('write_image', {
          path: 'attachments/imported.png',
          sourcePath: join(outside, 'desktop.png'),
        }),
        /^Wrote attachments\/imported\.png/,
      );
      assert.match(
        await harness.text('write_image', { path: 'attachments/leak.png', sourcePath: '/etc/hosts' }),
        /not inside an allowed import folder/,
      );
    } finally {
      await harness.close();
    }
  });

  test('importing is off unless a folder is configured', async () => {
    const harness = await openHarness(vault);
    try {
      assert.match(
        await harness.text('write_image', {
          path: 'attachments/nope.png',
          sourcePath: join(outside, 'desktop.png'),
        }),
        /PORTCALL_VAULT_IMPORT_DIRS/,
      );
    } finally {
      await harness.close();
    }
  });

  test('will not fetch a private address', async () => {
    const harness = await openHarness(vault);
    try {
      assert.match(
        await harness.text('write_image', { path: 'attachments/ssrf.png', url: 'http://localhost/a.png' }),
        /private address/,
      );
      assert.match(
        await harness.text('write_image', { path: 'attachments/ssrf.png', url: 'http://169.254.169.254/latest.png' }),
        /private address/,
      );
    } finally {
      await harness.close();
    }
  });
});

describe('choosing an output format', () => {
  test('keeps a photo as JPEG instead of inflating it to PNG', async () => {
    const harness = await openHarness(vault);
    try {
      const parts = await harness.call('read_image', { path: 'photo.jpg', maxEdge: 800 });
      const image = parts.find((part) => part.type === 'image');
      assert.equal(image?.mimeType, 'image/jpeg', 'a JPEG source comes back as JPEG');
    } finally {
      await harness.close();
    }
  });

  test('keeps a screenshot as PNG, where JPEG would be worse', async () => {
    const harness = await openHarness(vault);
    try {
      const parts = await harness.call('read_image', { path: 'wide.png', maxEdge: 200 });
      assert.equal(parts.find((part) => part.type === 'image')?.mimeType, 'image/png');
    } finally {
      await harness.close();
    }
  });

  test('a JPEG that already fits is passed through untouched', async () => {
    const harness = await openHarness(vault);
    try {
      const parts = await harness.call('read_image', { path: 'photo.jpg', maxEdge: 4096 });
      const image = parts.find((part) => part.type === 'image');
      assert.equal(image?.mimeType, 'image/jpeg');
      const onDisk = await readFile(join(vault, 'photo.jpg'));
      assert.equal(Buffer.from(image?.data ?? '', 'base64').byteLength, onDisk.byteLength);
    } finally {
      await harness.close();
    }
  });
});

describe('counting a use that is not an embed', () => {
  test('a frontmatter cover keeps an image out of the orphan list', async () => {
    const harness = await openHarness(vault);
    try {
      const listing = await harness.text('find_images', { query: 'covered' });
      assert.match(listing, /"cover\.md"/, 'the note that names it is credited');
      const orphans = await harness.text('find_images', { status: 'orphan' });
      assert.ok(!orphans.includes('covered.png'), 'an image used as a cover is not an orphan');
    } finally {
      await harness.close();
    }
  });

  test('a canvas node keeps an image out of the orphan list', async () => {
    const harness = await openHarness(vault);
    try {
      const listing = await harness.text('find_images', { query: 'boarded' });
      assert.match(listing, /"board\.canvas"/);
      const orphans = await harness.text('find_images', { status: 'orphan' });
      assert.ok(!orphans.includes('boarded.png'), 'an image on a canvas is not an orphan');
    } finally {
      await harness.close();
    }
  });

  test('frontmatter never invents a broken link', async () => {
    const harness = await openHarness(vault);
    try {
      const broken = await harness.text('find_images', { status: 'broken' });
      assert.match(broken, /gone\.png/, 'a real broken embed is still reported');
      assert.ok(!broken.includes('covered.png'));
    } finally {
      await harness.close();
    }
  });

  test('reports how much the matched images weigh', async () => {
    const harness = await openHarness(vault);
    try {
      const listing = await harness.text('find_images');
      assert.match(listing, /"matchedBytes": \d+/);
    } finally {
      await harness.close();
    }
  });
});

describe('delete_image', () => {
  test('needs the path repeated exactly', async () => {
    const harness = await openHarness(vault);
    try {
      await writeFile(join(vault, 'doomed.png'), png(8, 8));
      const message = await harness.text('delete_image', { path: 'doomed.png', confirmPath: 'other.png' });
      assert.match(message, /confirmPath does not match/);
      await access(join(vault, 'doomed.png'));
    } finally {
      await harness.close();
    }
  });

  test('deletes an orphan', async () => {
    const harness = await openHarness(vault);
    try {
      await writeFile(join(vault, 'doomed.png'), png(8, 8));
      assert.match(await harness.text('delete_image', { path: 'doomed.png', confirmPath: 'doomed.png' }), /^Deleted/);
      await assert.rejects(access(join(vault, 'doomed.png')));
    } finally {
      await harness.close();
    }
  });

  test('will not delete an image a note still embeds', async () => {
    const harness = await openHarness(vault);
    try {
      const message = await harness.text('delete_image', {
        path: 'attachments/wide.png',
        confirmPath: 'attachments/wide.png',
      });
      assert.match(message, /still used by .*note\.md/);
      await access(join(vault, 'attachments', 'wide.png'));
    } finally {
      await harness.close();
    }
  });

  test('will not delete an image only a cover or a canvas uses', async () => {
    const harness = await openHarness(vault);
    try {
      assert.match(
        await harness.text('delete_image', { path: 'covered.png', confirmPath: 'covered.png' }),
        /still used by cover\.md/,
      );
      assert.match(
        await harness.text('delete_image', { path: 'boarded.png', confirmPath: 'boarded.png' }),
        /still used by board\.canvas/,
      );
      await access(join(vault, 'covered.png'));
      await access(join(vault, 'boarded.png'));
    } finally {
      await harness.close();
    }
  });

  test('force deletes a referenced image and says what used it', async () => {
    const harness = await openHarness(vault);
    try {
      await writeFile(join(vault, 'used.png'), png(8, 8));
      await writeFile(join(vault, 'uses.md'), '![[used.png]]\n');
      const message = await harness.text('delete_image', {
        path: 'used.png',
        confirmPath: 'used.png',
        force: true,
      });
      assert.match(message, /was used by uses\.md/);
      await assert.rejects(access(join(vault, 'used.png')));
    } finally {
      await rm(join(vault, 'uses.md'), { force: true });
      await harness.close();
    }
  });

  test('names the near miss rather than deleting it', async () => {
    const harness = await openHarness(vault);
    try {
      const message = await harness.text('delete_image', { path: 'wide.png', confirmPath: 'wide.png' });
      assert.match(message, /not a vault path.*attachments\/wide\.png/s);
      await access(join(vault, 'attachments', 'wide.png'));
    } finally {
      await harness.close();
    }
  });

  test('a read-only mount offers no way to delete', async () => {
    const harness = await openHarness(vault, { readOnly: true });
    try {
      assert.ok(!(await harness.names()).includes('delete_image'));
    } finally {
      await harness.close();
    }
  });
});
