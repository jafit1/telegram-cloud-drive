/**
 * SYNC MEDIA NORMALISATION
 * ---------------------------------------------------------------------------
 * Pure functions, no Telegram client and no database, so they can be exercised
 * directly by test/sync-media.test.js. server.js requires them.
 *
 * A channel history hands back two different media shapes and the sync used to
 * look at exactly one of them — `msg.media.document`. An image sent through the
 * normal "send photo" path in any Telegram client is MessageMediaPhoto: it has
 * `msg.media.photo` and no document at all, so every one of those was skipped
 * without a word in the log. That is the concrete reason a finished sync could
 * still come back holding only part of the group.
 *
 * Nothing about retrieval needs to change to support them. Every download path
 * in server.js re-fetches the message by id (`client.getMessages(chatId, {
 * ids: [...] })`) and passes `msg.media` straight to `client.downloadMedia`,
 * which handles a photo and a document alike — telegram_media_id is the message
 * id, and that is the only field the download actually depends on. So a photo
 * needs a filename and a size, both derived here, and nothing else.
 */

// Telegram sizes a photo into several variants. PhotoSize carries one `size`;
// PhotoSizeProgressive carries a `sizes` array of increasing byte counts. The
// stripped/cached variants are thumbnails and carry `bytes`, not a length worth
// reporting. The largest number across all of them is what downloadMedia will
// actually fetch.
function largestPhotoSize(photo) {
  let best = 0;
  for (const s of (photo && photo.sizes) || []) {
    if (Array.isArray(s.sizes)) {
      for (const n of s.sizes) best = Math.max(best, Number(n) || 0);
    } else if (s.size != null) {
      best = Math.max(best, Number(s.size) || 0);
    }
  }
  return best;
}

// GramJS hands back Long/BigInt for several fields and node:sqlite refuses to
// bind those, so everything numeric goes through here before it reaches a query.
function toPlainNumber(v, fallback = 0) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return Number(v) || fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

// access_hash values exceed Number.MAX_SAFE_INTEGER, so they are stored as text.
function toIdString(v, fallback = '0') {
  if (v === null || v === undefined) return fallback;
  return typeof v === 'object' ? v.toString() : String(v);
}

function hexOrEmpty(ref) {
  if (!ref) return '';
  return Buffer.isBuffer(ref) ? ref.toString('hex') : String(ref);
}

/**
 * Normalises either media shape into the columns `files` actually has. Returns
 * null for a message carrying nothing storable (text, service messages, polls,
 * webpage previews …) so the caller can skip it.
 */
function describeSyncMedia(msg) {
  const media = msg && msg.media;
  if (!media) return null;

  if (media.document) {
    const doc = media.document;
    const filename = (doc.attributes || [])
      .filter(a => a.className === 'DocumentAttributeFilename')
      .map(a => a.fileName)[0] || `file_${msg.id}`;
    return {
      kind: 'document',
      filename,
      mimeType: doc.mimeType || 'application/octet-stream',
      totalSize: toPlainNumber(doc.size),
      accessHash: toIdString(doc.accessHash),
      fileReference: hexOrEmpty(doc.fileReference),
      dcId: toPlainNumber(doc.dcId, 4),
    };
  }

  if (media.photo) {
    const photo = media.photo;
    // Photos have no filename attribute — Telegram does not keep the original.
    // The message id keeps it unique and sortable, and .jpg is accurate: the
    // photo path always re-encodes to JPEG.
    return {
      kind: 'photo',
      filename: `photo_${msg.id}.jpg`,
      mimeType: 'image/jpeg',
      totalSize: largestPhotoSize(photo),
      accessHash: toIdString(photo.accessHash),
      fileReference: hexOrEmpty(photo.fileReference),
      dcId: toPlainNumber(photo.dcId, 4),
    };
  }

  return null;
}

/**
 * FLOOD_WAIT is the normal response to walking a large history, not a failure.
 * The old loop treated it as one: any throw hit `break`, so the sync stopped
 * early and still reported success. Waiting the requested number of seconds and
 * re-requesting the same offset is what the API is asking for.
 *
 * Returns 0 when the error is not a flood wait.
 */
function floodWaitSeconds(err) {
  if (!err) return 0;
  if (typeof err.seconds === 'number' && err.seconds > 0) return err.seconds;
  const m = /FLOOD_WAIT_(\d+)/.exec(err.message || '');
  return m ? parseInt(m[1], 10) : 0;
}

module.exports = {
  largestPhotoSize,
  toPlainNumber,
  toIdString,
  describeSyncMedia,
  floodWaitSeconds,
};
