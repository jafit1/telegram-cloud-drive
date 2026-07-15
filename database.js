const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// Use persistent volume if available (Railway.app volume mount)
const dataDir = process.env.DATA_DIR || __dirname;
const dbPath = path.join(dataDir, 'metadata.db');

let db;

try {
  db = new DatabaseSync(dbPath);
  // Enable WAL mode for better concurrent performance and crash recovery
  db.exec('PRAGMA journal_mode=WAL');
} catch (err) {
  console.error('Failed to open database:', err);
  process.exit(1);
}

function init() {
  // Create files table
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_key TEXT UNIQUE,
      filename TEXT,
      mime_type TEXT,
      category TEXT,
      total_size INTEGER,
      uploaded_at TEXT,
      telegram_media_id TEXT,
      access_hash TEXT,
      file_reference TEXT,
      telegram_thumb_id TEXT,
      dc_id INTEGER
    );
  `);

  // Run migrations to add missing columns to files table safely
  const columnsToAdd = [
    { name: 'telegram_media_id', type: 'TEXT' },
    { name: 'access_hash', type: 'TEXT' },
    { name: 'file_reference', type: 'TEXT' },
    { name: 'telegram_thumb_id', type: 'TEXT' },
    { name: 'dc_id', type: 'INTEGER' }
  ];

  columnsToAdd.forEach(col => {
    try {
      db.exec(`ALTER TABLE files ADD COLUMN ${col.name} ${col.type}`);
      console.log(`Migration: Added column ${col.name} to files table.`);
    } catch (e) {
      // Column already exists or table does not exist
    }
  });

  // Create activity_logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      action TEXT,
      details TEXT,
      status TEXT
    );
  `);

  console.log('Database schema checked and initialized.');
}

// Initialize tables on startup
init();

module.exports = {
  // Save file metadata
  saveFile(fileKey, filename, mimeType, category, totalSize, telegramMediaId, accessHash, fileReference, telegramThumbId = null, dcId = 4) {
    const query = db.prepare(`
      INSERT INTO files (file_key, filename, mime_type, category, total_size, uploaded_at, telegram_media_id, access_hash, file_reference, telegram_thumb_id, dc_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    return query.run(fileKey, filename, mimeType, category, totalSize, now, telegramMediaId, accessHash, fileReference, telegramThumbId, dcId);
  },

  // Retrieve files with search and category filters
  getFiles(searchQuery = '', category = 'all') {
    let sql = 'SELECT * FROM files';
    const params = [];
    const conditions = [];

    if (searchQuery) {
      conditions.push('filename LIKE ?');
      params.push(`%${searchQuery}%`);
    }
    if (category && category !== 'all') {
      conditions.push('category = ?');
      params.push(category);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY uploaded_at DESC';

    const query = db.prepare(sql);
    return query.all(...params);
  },

  // Retrieve single file by key
  getFile(fileKey) {
    const query = db.prepare('SELECT * FROM files WHERE file_key = ?');
    return query.get(fileKey);
  },

  getFileByNameAndSize(filename, totalSize) {
    const query = db.prepare('SELECT * FROM files WHERE filename = ? AND total_size = ?');
    return query.get(filename, totalSize);
  },

  // Delete file metadata
  deleteFile(fileKey) {
    const query = db.prepare('DELETE FROM files WHERE file_key = ?');
    return query.run(fileKey);
  },

  // Retrieve stats
  getStats() {
    const totalFilesQuery = db.prepare('SELECT COUNT(*) as count FROM files');
    const totalSizeQuery = db.prepare('SELECT SUM(total_size) as total_size FROM files');
    const categoryStatsQuery = db.prepare('SELECT category, COUNT(*) as count, SUM(total_size) as size FROM files GROUP BY category');

    const totalFiles = totalFilesQuery.get().count || 0;
    const totalSize = totalSizeQuery.get().total_size || 0;
    const categories = categoryStatsQuery.all();

    return {
      totalFiles,
      totalSize,
      categories
    };
  },

  // Save an activity log
  logActivity(action, details, status = 'success') {
    try {
      const query = db.prepare(`
        INSERT INTO activity_logs (timestamp, action, details, status)
        VALUES (?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      query.run(now, action, details, status);
    } catch (err) {
      console.error('Failed to log activity:', err);
    }
  },

  // Retrieve latest activity logs
  getLogs(limit = 100) {
    try {
      const query = db.prepare('SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT ?');
      return query.all(limit);
    } catch (err) {
      console.error('Failed to get activity logs:', err);
      return [];
    }
  },

  // Update file thumbnail ID
  updateFileThumb(fileKey, telegramThumbId) {
    try {
      const query = db.prepare('UPDATE files SET telegram_thumb_id = ? WHERE file_key = ?');
      return query.run(telegramThumbId, fileKey);
    } catch (err) {
      console.error('Failed to update file thumbnail ID:', err);
    }
  },

  // Clear all files and logs from database
  clearAllFiles() {
    try {
      db.prepare('DELETE FROM files').run();
      db.prepare('DELETE FROM activity_logs').run();
      return true;
    } catch (err) {
      console.error('Failed to clear files and logs:', err);
      throw err;
    }
  }
};
