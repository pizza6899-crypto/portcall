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
    assert.deepEqual(describeHeaders({ accept: ['application/json', 'text/event-stream'] }), {
      accept: 'application/json, text/event-stream',
    });
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

  test('a header nobody listed is redacted rather than trusted', () => {
    // The rule this follows: decide what to print, do not guess at what to
    // hide. A name-based blacklist only ever catches the secrets someone
    // thought of — the leak that prompted this was stored under `value`.
    for (const name of ['x-internal-secret', 'value', 'x-vault-key', 'x-amz-security-token']) {
      const described = describeHeaders({ [name]: TOKEN })[name] ?? '';
      assert.equal(described.includes(TOKEN), false, `${name} leaked its value`);
      assert.equal(described, `<${TOKEN.length} chars, ${digest(TOKEN)}>`, name);
    }
  });

  test('an unknown header keeps none of its value, not even the first word', () => {
    // `sketch` keeps the scheme, which is right for `Bearer <token>` and
    // wrong for a header whose first word could be the secret.
    assert.equal(describeHeaders({ 'x-odd': 'secret-part other-part' })['x-odd']?.includes('secret-part'), false);
  });

  test('the headers worth reading still read', () => {
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'claude-connector/1.0',
      'mcp-protocol-version': '2026-07-28',
      'cf-connecting-ip': '203.0.113.7',
      host: 'mcp.example.com',
    };
    assert.deepEqual(describeHeaders(headers), headers, 'redaction must not blind the diagnostic');
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
