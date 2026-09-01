/**
 * data-dir.js — resolves the one directory that holds all mutable state, and
 * migrates anything left over from when that state lived beside server.js.
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 * `dataDir` used to be computed independently in server.js and database.js as
 * `process.env.DATA_DIR || __dirname`. With DATA_DIR unset — which is the case
 * on every local run — that resolved to the project root, while the docs and
 * the setup wizard both pointed at ./data. The result was two live copies of
 * config.json holding the same credentials, and a metadata.db whose location
 * depended on how the process happened to be started.
 *
 * The default is now ./data unconditionally. Both callers import from here, so
 * there is exactly one definition.
 *
 * LOAD ORDER MATTERS: ./database opens the SQLite file at require time, so this
 * module must be required before it. server.js does that explicitly, and
 * database.js requires it too — so the migration runs first no matter which
 * module the process reaches first.
 */

const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

fs.mkdirSync(dataDir, { recursive: true });

/**
 * Files that legitimately used to sit in the project root. SQLite's -wal and
 * -shm sidecars must travel with their database or the move silently discards
 * committed transactions, so they are grouped rather than listed separately.
 */
const LEGACY_GROUPS = [
  { files: ['config.json'], critical: false },
  // critical: if these cannot be moved, SQLite would go on to open a brand-new
  // empty database at the destination while the populated one sits untouched in
  // the project root. The drive would come up looking empty. Better to refuse.
  { files: ['metadata.db', 'metadata.db-wal', 'metadata.db-shm'], critical: true },
];

/**
 * Move a legacy group into dataDir, but only when doing so cannot lose data:
 * every destination must be absent. If any destination already exists the group
 * is left completely untouched and the conflict is reported — overwriting a
 * live config.json or database to tidy up a path is never the right trade.
 */
function migrateLegacyFiles() {
  if (path.resolve(dataDir) === path.resolve(__dirname)) return;

  for (const { files: group, critical } of LEGACY_GROUPS) {
    const present = group.filter((name) => fs.existsSync(path.join(__dirname, name)));
    if (present.length === 0) continue;

    const blocked = group.filter((name) => fs.existsSync(path.join(dataDir, name)));

    if (blocked.length > 0) {
      console.warn(
        `[data-dir] Duplicate state detected. ${present.join(', ')} still exists in the project root ` +
        `while ${blocked.join(', ')} already exists in ${dataDir}. ` +
        `The copy in ${dataDir} is the one being used — the root copy is ignored and stale. ` +
        `Delete the root copy once you have confirmed the two match.`
      );
      continue;
    }

    for (const name of present) {
      const from = path.join(__dirname, name);
      const to = path.join(dataDir, name);
      try {
        fs.renameSync(from, to);
        console.log(`[data-dir] Migrated ${name} -> ${path.relative(__dirname, to)}`);
      } catch (err) {
        // EXDEV: different volumes (a mounted Railway volume). Copy then unlink.
        if (err.code === 'EXDEV') {
          fs.copyFileSync(from, to);
          fs.unlinkSync(from);
          console.log(`[data-dir] Copied ${name} across volumes -> ${path.relative(__dirname, to)}`);
        } else if (critical) {
          // Almost always EBUSY on Windows: another copy of the server is still
          // running and holding the database open. Naming that is far more
          // useful than the raw errno.
          throw new Error(
            `Could not move ${name} into ${dataDir}: ${err.message}
` +
            `  The database still lives in the project root and is in use by another process.
` +
            `  Stop any other running instance of this server, then start it again.
` +
            `  Starting now would create an empty database and the drive would look empty.`
          );
        } else {
          console.error(`[data-dir] Could not migrate ${name}:`, err.message);
        }
      }
    }
  }

  /**
   * gramjs-localstorage.json is deliberately NOT migrated. Node opens the path
   * given to --localstorage-file before any of our code runs, so moving a file
   * onto it here would race the open. Its contents are a datacentre/entity
   * cache that GramJS rebuilds on demand — the Telegram session itself lives in
   * config.json's sessionString — so a stale root copy is safe to just delete.
   */
  const strayLocalStorage = path.join(__dirname, 'gramjs-localstorage.json');
  if (fs.existsSync(strayLocalStorage) && path.resolve(dataDir) !== path.resolve(__dirname)) {
    console.warn(
      '[data-dir] gramjs-localstorage.json in the project root is no longer read ' +
      '(npm start now points --localstorage-file at data/). It only holds a rebuildable ' +
      'cache, so it is safe to delete.'
    );
  }
}

migrateLegacyFiles();

module.exports = { dataDir };
