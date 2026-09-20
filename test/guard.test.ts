import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { clientAddress, createGuard, isLoopback, type GuardOptions } from '../src/guard.js';

const OPTIONS: GuardOptions = {
  failureLimit: 3,
  windowMs: 60_000,
  blockMs: 300_000,
  rateLimit: 5,
  rateWindowMs: 10_000,
};

function guardWith(overrides: Partial<GuardOptions> = {}) {
  return createGuard({ ...OPTIONS, ...overrides });
}

describe('auth failure lockout', () => {
  test('blocks a client that keeps guessing', () => {
    const guard = guardWith();
    let now = 1_000;

    assert.equal(guard.recordFailure('1.2.3.4', now), false);
    assert.equal(guard.recordFailure('1.2.3.4', now), false);
    assert.equal(guard.recordFailure('1.2.3.4', now), true, 'the third failure trips the block');

    const verdict = guard.check('1.2.3.4', now);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.allowed === false && verdict.reason, 'blocked');
  });

  test('one client guessing does not lock out another', () => {
    const guard = guardWith();
    for (let i = 0; i < 3; i += 1) guard.recordFailure('1.2.3.4', 1_000);

    assert.equal(guard.check('1.2.3.4', 1_000).allowed, false);
    assert.equal(guard.check('5.6.7.8', 1_000).allowed, true);
  });

  test('the block lifts on its own', () => {
    const guard = guardWith();
    for (let i = 0; i < 3; i += 1) guard.recordFailure('1.2.3.4', 1_000);

    assert.equal(guard.check('1.2.3.4', 1_000 + 299_000).allowed, false);
    assert.equal(guard.check('1.2.3.4', 1_000 + 300_001).allowed, true);
  });

  test('failures spread beyond the window do not accumulate', () => {
    const guard = guardWith();

    // Two failures an hour apart is a typo, not an attack.
    assert.equal(guard.recordFailure('1.2.3.4', 1_000), false);
    assert.equal(guard.recordFailure('1.2.3.4', 1_000 + 3_600_000), false);
    assert.equal(guard.recordFailure('1.2.3.4', 1_000 + 7_200_000), false);
    assert.equal(guard.check('1.2.3.4', 1_000 + 7_200_000).allowed, true);
  });

  test('a success clears the client history', () => {
    const guard = guardWith();
    guard.recordFailure('1.2.3.4', 1_000);
    guard.recordFailure('1.2.3.4', 1_000);
    guard.recordSuccess('1.2.3.4');

    // A connector that proves it holds the token must not be one stray
    // failure away from a lockout for the rest of the window.
    assert.equal(guard.recordFailure('1.2.3.4', 2_000), false);
    assert.equal(guard.check('1.2.3.4', 2_000).allowed, true);
  });

  test('a zero limit turns the lockout off', () => {
    const guard = guardWith({ failureLimit: 0 });
    for (let i = 0; i < 50; i += 1) assert.equal(guard.recordFailure('1.2.3.4', 1_000), false);
    assert.equal(guard.check('1.2.3.4', 1_000).allowed, true);
  });
});

describe('rate cap', () => {
  test('refuses once the cap is reached, and says when to come back', () => {
    const guard = guardWith();
    for (let i = 0; i < 5; i += 1) assert.equal(guard.check('1.2.3.4', 1_000 + i).allowed, true);

    const verdict = guard.check('1.2.3.4', 1_100);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.allowed === false && verdict.reason, 'rate_limited');
    assert.ok(verdict.allowed === false && verdict.retryAfterSeconds > 0);
  });

  test('the window slides rather than resetting on a schedule', () => {
    const guard = guardWith();
    for (let i = 0; i < 5; i += 1) guard.check('1.2.3.4', 1_000);

    assert.equal(guard.check('1.2.3.4', 5_000).allowed, false);
    assert.equal(guard.check('1.2.3.4', 11_001).allowed, true, 'the earliest request has aged out');
  });

  test('a zero cap turns the limit off', () => {
    const guard = guardWith({ rateLimit: 0 });
    for (let i = 0; i < 1_000; i += 1) assert.equal(guard.check('1.2.3.4', 1_000).allowed, true);
  });

  test('clients that go quiet are forgotten rather than held forever', () => {
    const guard = guardWith();
    for (let i = 0; i < 100; i += 1) guard.check(`10.0.0.${i}`, 1_000);

    // Pruning runs on check, so one later call is enough to sweep.
    guard.check('10.0.0.1', 1_000 + 3_600_000);
    assert.equal(guard.blockedCount(1_000 + 3_600_000), 0);
  });
});

describe('client identity', () => {
  test('behind a loopback listener the proxy header is the real client', () => {
    assert.equal(clientAddress({ 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1', true), '203.0.113.9');
  });

  test('on a public interface the header is ignored', () => {
    // Anyone could set it there, and believing it would let one caller be
    // blocked under another caller's address.
    assert.equal(clientAddress({ 'cf-connecting-ip': '203.0.113.9' }, '198.51.100.7', false), '198.51.100.7');
  });

  test('a missing header falls back to the socket', () => {
    assert.equal(clientAddress({}, '127.0.0.1', true), '127.0.0.1');
  });

  test('loopback addresses are recognised', () => {
    assert.equal(isLoopback('127.0.0.1'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('0.0.0.0'), false);
  });
});
