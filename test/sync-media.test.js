/**
 * Tests for the sync media normalisation.
 *
 * Run: node --test test/
 *
 * The fixtures below mirror the shapes GramJS actually yields from
 * messages.GetHistory: Long-like objects (an object whose valueOf/toString
 * gives the number) for ids and sizes, Buffers for file references, and the
 * className discriminator on document attributes.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  describeSyncMedia,
  largestPhotoSize,
  floodWaitSeconds,
  toPlainNumber,
  toIdString,
} = require('../sync-media');

// A Long-like stand-in: GramJS returns these, and they must not reach SQLite raw.
function long(n) {
  return { valueOf: () => Number(n), toString: () => String(n) };
}

function documentMessage(id, filename, size) {
  return {
    id,
    media: {
      className: 'MessageMediaDocument',
      document: {
        id: long('5000' + id),
        accessHash: long('-7249597263096059913'),
        fileReference: Buffer.from('deadbeef', 'hex'),
        mimeType: 'application/pdf',
        size: long(size),
        dcId: 5,
        attributes: [
          { className: 'DocumentAttributeFilename', fileName: filename },
        ],
      },
    },
  };
}

function photoMessage(id, sizes) {
  return {
    id,
    media: {
      className: 'MessageMediaPhoto',
      photo: {
        id: long('9000' + id),
        accessHash: long('2287189938699883545'),
        fileReference: Buffer.from('cafe', 'hex'),
        dcId: 2,
        sizes,
      },
    },
  };
}

test('a document message keeps its declared filename', () => {
  const info = describeSyncMedia(documentMessage(340, 'laporan.pdf', 280729));
  assert.strictEqual(info.kind, 'document');
  assert.strictEqual(info.filename, 'laporan.pdf');
  assert.strictEqual(info.mimeType, 'application/pdf');
  assert.strictEqual(info.totalSize, 280729);
  assert.strictEqual(typeof info.totalSize, 'number', 'SQLite cannot bind a Long');
  assert.strictEqual(info.accessHash, '-7249597263096059913');
  assert.strictEqual(info.fileReference, 'deadbeef');
  assert.strictEqual(info.dcId, 5);
});

test('a document with no filename attribute falls back to the message id', () => {
  const msg = documentMessage(41, 'ignored', 10);
  msg.media.document.attributes = [];
  assert.strictEqual(describeSyncMedia(msg).filename, 'file_41');
});

test('a photo message is recognised — this is the regression', () => {
  // Before the fix the sync tested only `msg.media.document`, so a photo
  // returned nothing and was skipped silently: the drive came back holding a
  // subset of the group with no explanation in the log.
  const info = describeSyncMedia(photoMessage(512, [
    { className: 'PhotoStrippedSize', bytes: Buffer.alloc(4) },
    { className: 'PhotoSize', type: 'm', size: 21_000 },
    { className: 'PhotoSize', type: 'x', size: 154_233 },
  ]));
  assert.notStrictEqual(info, null, 'a photo must not be skipped');
  assert.strictEqual(info.kind, 'photo');
  assert.strictEqual(info.filename, 'photo_512.jpg');
  assert.strictEqual(info.mimeType, 'image/jpeg');
  assert.strictEqual(info.totalSize, 154_233, 'largest variant wins');
  assert.strictEqual(info.dcId, 2);
  assert.strictEqual(info.fileReference, 'cafe');
});

test('PhotoSizeProgressive reports the largest byte count in its sizes array', () => {
  const info = describeSyncMedia(photoMessage(513, [
    { className: 'PhotoSize', type: 's', size: 900 },
    { className: 'PhotoSizeProgressive', type: 'y', sizes: [1000, 40_000, 120_500] },
  ]));
  assert.strictEqual(info.totalSize, 120_500);
});

test('a photo with no usable size still syncs, at size 0', () => {
  // Worth having a row for: retrieval goes by message id, not by size.
  const info = describeSyncMedia(photoMessage(514, [
    { className: 'PhotoStrippedSize', bytes: Buffer.alloc(8) },
  ]));
  assert.strictEqual(info.totalSize, 0);
  assert.strictEqual(info.filename, 'photo_514.jpg');
});

test('messages carrying nothing storable are skipped', () => {
  assert.strictEqual(describeSyncMedia({ id: 1 }), null, 'plain text');
  assert.strictEqual(describeSyncMedia({ id: 2, media: null }), null, 'explicit null media');
  assert.strictEqual(
    describeSyncMedia({ id: 3, media: { className: 'MessageMediaWebPage', webpage: {} } }),
    null,
    'link preview'
  );
  assert.strictEqual(describeSyncMedia(null), null, 'no message at all');
});

test('largestPhotoSize tolerates a missing or empty sizes list', () => {
  assert.strictEqual(largestPhotoSize(undefined), 0);
  assert.strictEqual(largestPhotoSize({}), 0);
  assert.strictEqual(largestPhotoSize({ sizes: [] }), 0);
});

test('floodWaitSeconds reads the wait off either the property or the message', () => {
  assert.strictEqual(floodWaitSeconds({ seconds: 32 }), 32, 'GramJS FloodWaitError');
  assert.strictEqual(floodWaitSeconds(new Error('FLOOD_WAIT_17')), 17, 'raw RPC text');
  assert.strictEqual(
    floodWaitSeconds(new Error('A wait of 420 seconds is required (caused by FLOOD_WAIT_420)')),
    420
  );
  assert.strictEqual(floodWaitSeconds(new Error('AUTH_KEY_UNREGISTERED')), 0, 'not a flood wait');
  assert.strictEqual(floodWaitSeconds(null), 0);
  assert.strictEqual(floodWaitSeconds({ seconds: 0 }), 0);
});

test('numeric and id coercion produce values SQLite can bind', () => {
  assert.strictEqual(toPlainNumber(long(4_919_920)), 4_919_920);
  assert.strictEqual(toPlainNumber('42'), 42);
  assert.strictEqual(toPlainNumber(undefined, 4), 4);
  assert.strictEqual(toPlainNumber('not a number', 4), 4);
  assert.strictEqual(toIdString(long('7578746088236638056')), '7578746088236638056');
  assert.strictEqual(toIdString(undefined), '0');
});
