import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalExtension,
  extensionOf,
  isImagePath,
  mimeTypeOf,
  parseDimensions,
  sniffFormat,
} from '../src/plugins/vault/media.js';
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
