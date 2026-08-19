import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { detailedHealthRoute, resolveMounts, routeKey } from '../src/routes.js';
import type { Plugin } from '../src/types.js';

/** A plugin stub — resolveMounts never touches the handler. */
function stub(name: string, path: string): Plugin {
  return { name, path, handler: {} as Plugin['handler'] };
}

describe('resolveMounts', () => {
  test('mounts each plugin under /<path>/mcp', () => {
    const mounts = resolveMounts([stub('vault', 'vault'), stub('notes', 'notes')]);
    assert.deepEqual([...mounts.keys()].sort(), ['/notes/mcp', '/vault/mcp']);
  });

  test('an alias points at the very same plugin instance', () => {
    const vault = stub('vault', 'vault');
    const mounts = resolveMounts([vault], { aliasRootMcp: 'vault' });

    assert.equal(mounts.get('/mcp'), vault);
    assert.equal(mounts.get('/vault/mcp'), vault);
    // Identity matters: the server derives one adapter per plugin instance.
    assert.equal(mounts.get('/mcp'), mounts.get('/vault/mcp'));
  });

  test('no alias is added when none is configured', () => {
    const mounts = resolveMounts([stub('vault', 'vault')]);
    assert.equal(mounts.has('/mcp'), false);
  });

  test('an alias naming an unknown plugin fails loudly at startup', () => {
    assert.throws(
      () => resolveMounts([stub('vault', 'vault')], { aliasRootMcp: 'typo' }),
      /unknown plugin path: typo/,
    );
  });

  test('two plugins on one path fail rather than silently shadowing', () => {
    assert.throws(
      () => resolveMounts([stub('first', 'vault'), stub('second', 'vault')]),
      /Two plugins are mounted at \/vault\/mcp/,
    );
  });

  test('a path containing a slash is rejected', () => {
    assert.throws(() => resolveMounts([stub('nested', 'a/b')]), /Plugin "nested" mount path must be a single non-empty path segment/);
  });

  test('an empty path is rejected', () => {
    assert.throws(() => resolveMounts([stub('blank', '')]), /Plugin "blank" mount path must be a single non-empty path segment/);
  });

  test('no plugins yields no mounts', () => {
    assert.equal(resolveMounts([]).size, 0);
  });
});

describe('routeKey', () => {
  test('keeps a plain path as-is', () => {
    assert.equal(routeKey('/vault/mcp'), '/vault/mcp');
  });

  test('drops trailing slashes', () => {
    assert.equal(routeKey('/vault/mcp/'), '/vault/mcp');
    assert.equal(routeKey('/vault/mcp///'), '/vault/mcp');
  });

  test('drops the query string', () => {
    assert.equal(routeKey('/vault/mcp?token=abc'), '/vault/mcp');
  });

  test('root stays root', () => {
    assert.equal(routeKey('/'), '/');
    assert.equal(routeKey(undefined), '/');
  });

  test('percent-encoded separators do not smuggle in a different route', () => {
    // %2F stays encoded in pathname, so this cannot resolve to /vault/mcp.
    assert.notEqual(routeKey('/vault%2Fmcp'), '/vault/mcp');
  });
});

describe('resolveMounts with a secret path prefix', () => {
  const opts = { aliasRootMcp: 'vault', pathPrefix: 's3cr3t' };

  test('every mount moves behind the prefix', () => {
    const mounts = resolveMounts([stub('vault', 'vault')], opts);
    assert.deepEqual([...mounts.keys()].sort(), ['/s3cr3t/mcp', '/s3cr3t/vault/mcp']);
  });

  test('the unprefixed paths stop existing', () => {
    const mounts = resolveMounts([stub('vault', 'vault')], opts);
    assert.equal(mounts.has('/vault/mcp'), false);
    assert.equal(mounts.has('/mcp'), false);
  });

  test('the alias still resolves to the same instance', () => {
    const vault = stub('vault', 'vault');
    const mounts = resolveMounts([vault], opts);
    assert.equal(mounts.get('/s3cr3t/mcp'), vault);
    assert.equal(mounts.get('/s3cr3t/mcp'), mounts.get('/s3cr3t/vault/mcp'));
  });

  test('an alias naming an unknown plugin still fails', () => {
    assert.throws(
      () => resolveMounts([stub('vault', 'vault')], { aliasRootMcp: 'typo', pathPrefix: 's3cr3t' }),
      /unknown plugin path: typo/,
    );
  });

  test('a prefix containing a slash is rejected', () => {
    assert.throws(
      () => resolveMounts([stub('vault', 'vault')], { pathPrefix: 'a/b' }),
      /PORTCALL_PATH_PREFIX must be a single non-empty path segment/,
    );
  });

  test('an empty prefix is rejected rather than silently ignored', () => {
    assert.throws(() => resolveMounts([stub('vault', 'vault')], { pathPrefix: '' }), /PORTCALL_PATH_PREFIX/);
  });
});

describe('detailedHealthRoute', () => {
  test('stays at /healthz when no prefix is configured', () => {
    assert.equal(detailedHealthRoute(undefined), '/healthz');
  });

  test('moves behind the prefix, so the mount listing is not guessable', () => {
    assert.equal(detailedHealthRoute('s3cr3t'), '/s3cr3t/healthz');
  });
});
