/**
 * Tests for the temp mail helpers (mail.tm integration).
 *
 * Run: node --test test/
 *
 * Only the pure shaping functions are covered — the network half is a handful of
 * fetch calls with no branching worth a mock, and faking mail.tm's JSON-LD would
 * just restate what this file already assumes about it. The fixtures below are
 * copied from real responses.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  hydraList,
  pickActiveDomain,
  newAddress,
  newPassword,
  shapeMessage,
} = require('../tempmail');

// mail.tm answers in JSON-LD, so the array lives under 'hydra:member'.
test('hydraList reads the JSON-LD envelope', () => {
  assert.deepEqual(
    hydraList({ 'hydra:totalItems': 1, 'hydra:member': [{ id: 'a' }] }),
    [{ id: 'a' }]
  );
});

test('hydraList falls back to the plain key', () => {
  assert.deepEqual(hydraList({ member: [{ id: 'b' }] }), [{ id: 'b' }]);
});

// An inbox that fails to parse must look empty, not become a 500.
test('hydraList survives absent and malformed bodies', () => {
  assert.deepEqual(hydraList(null), []);
  assert.deepEqual(hydraList(undefined), []);
  assert.deepEqual(hydraList('not an object'), []);
  assert.deepEqual(hydraList({}), []);
  assert.deepEqual(hydraList({ 'hydra:member': 'nope' }), []);
  assert.deepEqual(hydraList([]), []);
});

test('pickActiveDomain prefers an active domain', () => {
  const domains = [
    { domain: 'off.com', isActive: false },
    { domain: 'on.com', isActive: true },
  ];
  assert.equal(pickActiveDomain(domains), 'on.com');
});

// A shape change upstream should degrade, not dead-end.
test('pickActiveDomain falls back when none are active', () => {
  assert.equal(pickActiveDomain([{ domain: 'only.com', isActive: false }]), 'only.com');
  assert.equal(pickActiveDomain([{ isActive: true }]), '');
  assert.equal(pickActiveDomain([]), '');
  assert.equal(pickActiveDomain([null, undefined]), '');
});

test('newAddress is random and domain-suffixed', () => {
  const a = newAddress('uberip.com');
  const b = newAddress('uberip.com');
  assert.match(a, /^[0-9a-f]{10}@uberip\.com$/);
  assert.notEqual(a, b);
});

test('newPassword is random and filesystem/shell-safe', () => {
  const p = newPassword();
  assert.ok(p.length >= 16);
  assert.notEqual(p, newPassword());
  // base64url only — no '+' or '/' to trip up a query string or a JSON body.
  assert.match(p, /^[A-Za-z0-9_-]+$/);
});

test('shapeMessage keeps only what the UI renders', () => {
  const shaped = shapeMessage({
    id: '6f1c0a',
    from: { address: 'noreply@x.com', name: 'X Corp' },
    subject: 'Your code',
    intro: '123456',
    seen: true,
    createdAt: '2026-08-30T10:00:00+00:00',
    // JSON-LD noise that must not reach a browser.
    '@id': '/messages/6f1c0a',
    '@type': 'https://schema.org/EmailMessage',
    hasAttachment: false,
  });
  assert.deepEqual(shaped, {
    id: '6f1c0a',
    from: 'noreply@x.com',
    fromName: 'X Corp',
    subject: 'Your code',
    intro: '123456',
    seen: true,
    createdAt: '2026-08-30T10:00:00+00:00',
  });
});

// A message with no from block still has to render a row, not throw.
test('shapeMessage tolerates missing fields', () => {
  const shaped = shapeMessage({ id: 'x' });
  assert.deepEqual(shaped, {
    id: 'x',
    from: '',
    fromName: '',
    subject: '(tanpa subjek)',
    intro: '',
    seen: false,
    createdAt: '',
  });
});

test('shapeMessage rejects non-objects', () => {
  assert.equal(shapeMessage(null), null);
  assert.equal(shapeMessage(undefined), null);
  assert.equal(shapeMessage('string'), null);
});
