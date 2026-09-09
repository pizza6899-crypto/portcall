import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { describeHeaders, digest } from '../src/log.js';

const TOKEN = 'correct-horse-battery-staple';

describe('describeHeaders', () => {
  test('ordinary headers pass through unchanged', () => {
    assert.deepEqual(describeHeaders({ 'content-type': 'application/json' }), {
      'content-type': 'application/json',
    });
  });

  test('absent headers are dropped rather than rendered as undefined', () => {
    assert.deepEqual(describeHeaders({ accept: undefined }), {});
  });

  test('repeated headers are joined', () => {
    assert.deepEqual(describeHeaders({ 'set-cookie': ['a=1', 'b=2'] }), { 'set-cookie': 'a=1, b=2' });
  });

  test('a bearer secret never appears in the output', () => {
    const described = describeHeaders({ authorization: `Bearer ${TOKEN}` });
    assert.equal(described.authorization?.includes(TOKEN), false);
  });

  test('the scheme survives redaction, so a missing one is visible', () => {
    assert.match(describeHeaders({ authorization: `Bearer ${TOKEN}` }).authorization ?? '', /^Bearer </);
    assert.match(describeHeaders({ authorization: TOKEN }).authorization ?? '', /^</);
  });

  test('the length and digest identify which secret arrived', () => {
    assert.equal(
      describeHeaders({ authorization: `Bearer ${TOKEN}` }).authorization,
      `Bearer <${TOKEN.length} chars, ${digest(TOKEN)}>`,
    );
  });

  test('sensitive names are matched regardless of case', () => {
    for (const name of ['Authorization', 'X-API-Key', 'x-auth-token', 'Cookie', 'proxy-authorization']) {
      assert.equal(describeHeaders({ [name]: TOKEN })[name]?.includes(TOKEN), false, name);
    }
  });
});

describe('digest', () => {
  test('the same secret digests to the same sketch', () => {
    assert.equal(digest(TOKEN), digest(TOKEN));
  });

  test('a different secret digests differently', () => {
    assert.notEqual(digest(TOKEN), digest(`${TOKEN}!`));
  });
});
