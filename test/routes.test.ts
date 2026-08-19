import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveMounts, routeKey } from '../src/routes.js';
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
    const mounts = resolveMounts([vault], 'vault');

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
      () => resolveMounts([stub('vault', 'vault')], 'typo'),
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
    assert.throws(() => resolveMounts([stub('nested', 'a/b')]), /invalid mount path/);
  });

  test('an empty path is rejected', () => {
    assert.throws(() => resolveMounts([stub('blank', '')]), /invalid mount path/);
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
