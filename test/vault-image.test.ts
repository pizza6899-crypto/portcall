import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

import { InMemoryTransport } from '@modelcontextprotocol/server';
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
      assert.match(stats, /"notes":\s*2/);
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
