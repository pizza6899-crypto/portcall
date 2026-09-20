import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalExtension,
  extensionMatchesFormat,
  extensionOf,
  isImagePath,
  mimeTypeOf,
  parseDimensions,
  sniffFormat,
} from '../src/plugins/vault/media.js';
import { drain, isPrivateAddress } from '../src/plugins/vault/image.js';
import { canvasRefs, frontmatterRefs, insideVault, parseEmbeds, resolveTarget } from '../src/plugins/vault/paths.js';

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function gifHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(10);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

function jpegHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(39);
  header.writeUInt16BE(0xffd8, 0);
  header.writeUInt16BE(0xffe0, 2);
  header.writeUInt16BE(16, 4); // APP0, skipped on the way to the frame header
  header.write('JFIF\0', 6, 'latin1');
  header.writeUInt16BE(0xffc0, 20);
  header.writeUInt16BE(17, 22);
  header.writeUInt8(8, 24);
  header.writeUInt16BE(height, 25);
  header.writeUInt16BE(width, 27);
  return header;
}

function webpHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(22, 4);
  header.write('WEBP', 8, 'latin1');
  header.write('VP8X', 12, 'latin1');
  header.writeUInt32LE(10, 16);
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);
  return header;
}

describe('dimension parsing', () => {
  test('reads each format from its header', () => {
    assert.deepEqual(parseDimensions(pngHeader(1920, 1080)), { width: 1920, height: 1080 });
    assert.deepEqual(parseDimensions(gifHeader(320, 240)), { width: 320, height: 240 });
    assert.deepEqual(parseDimensions(jpegHeader(4032, 3024)), { width: 4032, height: 3024 });
    assert.deepEqual(parseDimensions(webpHeader(800, 600)), { width: 800, height: 600 });
  });

  test('gives up rather than guessing', () => {
    assert.equal(parseDimensions(Buffer.from('not an image at all, just text')), undefined);
    assert.equal(parseDimensions(Buffer.alloc(0)), undefined);
    assert.equal(parseDimensions(Buffer.alloc(4)), undefined);
  });
});

describe('format sniffing', () => {
  test('identifies what it is handed', () => {
    assert.equal(sniffFormat(pngHeader(1, 1)), 'png');
    assert.equal(sniffFormat(jpegHeader(1, 1)), 'jpeg');
    assert.equal(sniffFormat(gifHeader(1, 1)), 'gif');
    assert.equal(sniffFormat(webpHeader(1, 1)), 'webp');
    assert.equal(sniffFormat(Buffer.from('BM_and_then_some')), 'bmp');
    assert.equal(sniffFormat(Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4])), 'tiff');
    assert.equal(sniffFormat(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 1, 2, 3, 4])), 'tiff');
    assert.equal(sniffFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
  });

  test('reads the brand of an ISO container', () => {
    const heic = Buffer.alloc(16);
    heic.write('ftypheic', 4, 'latin1');
    assert.equal(sniffFormat(heic), 'heic');

    const avif = Buffer.alloc(16);
    avif.write('ftypavif', 4, 'latin1');
    assert.equal(sniffFormat(avif), 'avif');
  });

  test('refuses to call arbitrary bytes an image', () => {
    assert.equal(sniffFormat(Buffer.from('hello world, definitely not an image')), undefined);
    assert.equal(sniffFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), undefined);
  });
});

describe('path classification', () => {
  test('knows which extensions are images', () => {
    for (const path of ['a.png', 'b.JPG', 'c/d.jpeg', 'e.gif', 'f.webp', 'g.svg', 'h.heic', 'i.tiff']) {
      assert.equal(isImagePath(path), true, path);
    }
    for (const path of ['note.md', 'data.json', 'archive.zip', 'noextension']) {
      assert.equal(isImagePath(path), false, path);
    }
  });

  test('maps extensions to media types', () => {
    assert.equal(mimeTypeOf('a.png'), 'image/png');
    assert.equal(mimeTypeOf('a.JPEG'), 'image/jpeg');
    assert.equal(mimeTypeOf('a.svg'), 'image/svg+xml');
    assert.equal(mimeTypeOf('a.md'), undefined);
    assert.equal(extensionOf('folder.with.dots/file.PNG'), 'png');
    assert.equal(canonicalExtension('jpeg'), 'jpg');
  });
});

describe('staying inside the vault', () => {
  test('rejects anything that climbs out', () => {
    for (const candidate of ['../escape.png', 'a/../../escape.png', '/etc/passwd', '']) {
      assert.throws(() => insideVault('/vault', candidate), /escapes the vault/, candidate);
    }
  });

  test('resolves a nested path', () => {
    assert.equal(insideVault('/vault', 'attachments/shot.png'), '/vault/attachments/shot.png');
    assert.equal(insideVault('/vault', './attachments/shot.png'), '/vault/attachments/shot.png');
  });
});

describe('embed parsing', () => {
  test('finds both Obsidian syntaxes', () => {
    const markdown = [
      '![[plain.png]]',
      '![[aliased.png|alt text]]',
      '![[sectioned.png#top]]',
      '![caption](markdown%20style.png)',
      '![](folder/nested.png)',
    ].join('\n\n');

    assert.deepEqual(parseEmbeds(markdown), [
      'plain.png',
      'aliased.png',
      'sectioned.png',
      'markdown style.png',
      'folder/nested.png',
    ]);
  });

  test('skips what no vault file sits behind', () => {
    const markdown = '![remote](https://example.com/a.png)\n\n![inline](data:image/png;base64,AAA)\n\n![anchor](#section)';
    assert.deepEqual(parseEmbeds(markdown), []);
  });

  test('ignores a plain link, which is not an embed', () => {
    assert.deepEqual(parseEmbeds('[[some note]] and [a link](target.png)'), []);
  });
});

describe('resolving an embed target', () => {
  const files = ['a/shot.png', 'b/shot.png', 'c/unique.png', 'note.md'];

  test('prefers an exact vault-relative path', () => {
    assert.deepEqual(resolveTarget('a/shot.png', files), ['a/shot.png']);
  });

  test('matches a bare filename across the vault', () => {
    assert.deepEqual(resolveTarget('unique.png', files), ['c/unique.png']);
  });

  test('reports every candidate when a name is ambiguous', () => {
    assert.deepEqual(resolveTarget('shot.png', files), ['a/shot.png', 'b/shot.png']);
  });

  test('finds nothing for a name that is not there', () => {
    assert.deepEqual(resolveTarget('missing.png', files), []);
  });
});

describe('frontmatter references', () => {
  test('finds an image however the note names it', () => {
    assert.deepEqual(frontmatterRefs('---\ncover: shot.png\n---\nbody'), ['shot.png']);
    assert.deepEqual(frontmatterRefs('---\nbanner: "[[a banner.png]]"\n---\n')[0], 'a banner.png');
    assert.deepEqual(frontmatterRefs('---\nthumbs:\n  - a.png\n  - sub/b.jpg\n---\n'), ['a.png', 'sub/b.jpg']);
    assert.deepEqual(frontmatterRefs('---\ngallery: [x.png, y.webp]\n---\n'), ['x.png', 'y.webp']);
  });

  test('ignores what is not a vault image', () => {
    assert.deepEqual(frontmatterRefs('---\nimage: https://example.com/remote.png\n---\n'), []);
    assert.deepEqual(frontmatterRefs('---\ntitle: Notes\ntags: [a, b]\ndate: 2026-09-20\nfile: report.pdf\n---\n'), []);
    assert.deepEqual(frontmatterRefs('# Heading\n\n---\n\ncover: notfrontmatter.png\n'), []);
    assert.deepEqual(frontmatterRefs('no frontmatter at all\n\n![[body.png]]\n'), []);
  });
});

describe('canvas references', () => {
  test('collects the files a board places', () => {
    const board = JSON.stringify({
      nodes: [
        { id: '1', type: 'file', file: 'diagram.png' },
        { id: '2', type: 'text', text: 'hello' },
        { id: '3', type: 'file', file: 'note.md' },
      ],
      edges: [],
    });
    assert.deepEqual(canvasRefs(board), ['diagram.png', 'note.md']);
  });

  test('skips a canvas it cannot read rather than failing', () => {
    assert.deepEqual(canvasRefs('not json at all'), []);
    assert.deepEqual(canvasRefs('{"nodes":"wrong shape"}'), []);
    assert.deepEqual(canvasRefs('{}'), []);
  });
});

describe('an extension that is an alias, not a mismatch', () => {
  test('every extension the vault accepts can also be written', () => {
    // `isImagePath` lets these into the vault, so refusing them on the way in
    // rejects a correct file and asks for a rename to something no better.
    for (const [extension, format] of [
      ['jpg', 'jpeg'],
      ['jpeg', 'jpeg'],
      ['tif', 'tiff'],
      ['tiff', 'tiff'],
      ['heic', 'heic'],
      ['heif', 'heic'],
      ['png', 'png'],
      ['gif', 'gif'],
      ['webp', 'webp'],
      ['bmp', 'bmp'],
      ['avif', 'avif'],
      ['ico', 'ico'],
      ['svg', 'svg'],
    ] as const) {
      assert.ok(isImagePath(`x.${extension}`), `.${extension} is stored in the vault`);
      assert.ok(extensionMatchesFormat(extension, format), `.${extension} must be allowed to hold ${format}`);
    }
  });

  test('a genuine mismatch is still refused, and names the right extension', () => {
    assert.equal(extensionMatchesFormat('png', 'jpeg'), false);
    assert.equal(extensionMatchesFormat('tif', 'png'), false);
    assert.equal(canonicalExtension('tiff'), 'tif');
    assert.equal(canonicalExtension('jpeg'), 'jpg');
  });

  test('an icon is recognised at all', () => {
    // Without this, `.ico` was a path the vault accepted and nothing could
    // ever be written to, because the bytes sniffed as no format.
    const ico = Buffer.alloc(22);
    ico.writeUInt16LE(0, 0);
    ico.writeUInt16LE(1, 2); // type: icon
    ico.writeUInt16LE(1, 4); // one image
    assert.equal(sniffFormat(ico), 'ico');

    const notAnIcon = Buffer.alloc(22); // the image count stays zero
    assert.equal(sniffFormat(notAnIcon), undefined);
  });
});

describe('addresses a URL import must not reach', () => {
  test('the ordinary private ranges', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1']) {
      assert.equal(isPrivateAddress(address), true, `${address} is private`);
    }
  });

  test('an IPv4 destination wearing IPv6 notation', () => {
    // A host controls its own AAAA record, so this is a bypass it can simply
    // publish. Both spellings resolve to the same place.
    assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateAddress('::ffff:10.0.0.5'), true);
    assert.equal(isPrivateAddress('::ffff:7f00:1'), true, 'the hex spelling of 127.0.0.1');
    assert.equal(isPrivateAddress('::ffff:a00:5'), true, 'the hex spelling of 10.0.0.5');
  });

  test('carrier-grade NAT, where a mesh VPN puts its peers', () => {
    assert.equal(isPrivateAddress('100.64.0.1'), true);
    assert.equal(isPrivateAddress('100.100.100.100'), true);
    assert.equal(isPrivateAddress('100.128.0.1'), false, 'just outside the /10 is ordinary public space');
  });

  test('a public address is still reachable', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      assert.equal(isPrivateAddress(address), false, `${address} is public`);
    }
  });

  test('something unparseable is refused rather than allowed', () => {
    for (const address of ['', 'not-an-address', '10.0.0', '1.2.3.4.5', '300.1.1.1']) {
      assert.equal(isPrivateAddress(address), true, `${address} cannot be reasoned about`);
    }
  });
});

describe('a download that will not fit', () => {
  /** A body that keeps producing until it is cancelled. */
  function endless(chunkBytes: number): Response {
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += chunkBytes;
        // Far past any ceiling: if the cap only applied after buffering, this
        // test would sit here allocating until it fell over.
        if (produced > 4_000_000_000) controller.close();
        else controller.enqueue(new Uint8Array(chunkBytes));
      },
    });
    return new Response(stream, { headers: { 'content-type': 'image/png' } });
  }

  test('an oversized body is cut off while it streams, not after', async () => {
    await assert.rejects(() => drain(endless(1_000_000)), /larger than/);
  });

  test('a declared length over the limit is refused on the header alone', async () => {
    // The body here is a few bytes. Only the `content-length` can have
    // produced this refusal, which is the point: the free check runs first
    // and a huge download is turned away before it is pulled.
    const response = new Response(Buffer.from('tiny'), { headers: { 'content-length': '900000000' } });
    await assert.rejects(() => drain(response), /declares 900000000 bytes/);
  });

  test('a body within the limit comes back whole', async () => {
    const body = Buffer.from('a small image, notionally');
    assert.deepEqual(await drain(new Response(body)), body);
  });
});
