import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isAuthorized } from '../src/auth.js';

const TOKEN = 'correct-horse-battery-staple';

describe('isAuthorized', () => {
  test('an unconfigured token leaves the endpoint open', () => {
    assert.equal(isAuthorized(undefined, undefined), true);
    assert.equal(isAuthorized('Bearer anything', undefined), true);
  });

  test('the matching token is accepted', () => {
    assert.equal(isAuthorized(`Bearer ${TOKEN}`, TOKEN), true);
  });

  test('the scheme is matched case-insensitively', () => {
    assert.equal(isAuthorized(`bearer ${TOKEN}`, TOKEN), true);
    assert.equal(isAuthorized(`BEARER ${TOKEN}`, TOKEN), true);
  });

  test('a missing header is refused', () => {
    assert.equal(isAuthorized(undefined, TOKEN), false);
  });

  test('a wrong token of the same length is refused', () => {
    const wrong = 'x'.repeat(TOKEN.length);
    assert.equal(wrong.length, TOKEN.length);
    assert.equal(isAuthorized(`Bearer ${wrong}`, TOKEN), false);
  });

  test('a token of a different length is refused', () => {
    assert.equal(isAuthorized('Bearer short', TOKEN), false);
    assert.equal(isAuthorized(`Bearer ${TOKEN}extra`, TOKEN), false);
  });

  test('a prefix of the token is refused', () => {
    assert.equal(isAuthorized(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false);
  });

  test('another scheme is refused even when it carries the token', () => {
    assert.equal(isAuthorized(`Basic ${TOKEN}`, TOKEN), false);
    assert.equal(isAuthorized(TOKEN, TOKEN), false);
  });

  test('an empty header is refused', () => {
    assert.equal(isAuthorized('', TOKEN), false);
    assert.equal(isAuthorized('Bearer', TOKEN), false);
    assert.equal(isAuthorized('Bearer ', TOKEN), false);
  });

  test('surrounding whitespace in the credential is tolerated', () => {
    assert.equal(isAuthorized(`Bearer   ${TOKEN}  `, TOKEN), true);
  });
});
