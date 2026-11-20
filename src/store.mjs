import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openStore(path, scope, seed = false) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('This library was created by a newer Vitreign version.');
    if (version === 0) {
      db.exec(`
        CREATE TABLE favorite (
          scope TEXT NOT NULL, asset TEXT NOT NULL, PRIMARY KEY (scope, asset)
        ) STRICT;
        CREATE TABLE reel (
          scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
          PRIMARY KEY (scope, id)
        ) STRICT;
        CREATE TABLE frame (
          seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, reel TEXT NOT NULL, asset TEXT NOT NULL,
          UNIQUE (scope, reel, asset),
          FOREIGN KEY (scope, reel) REFERENCES reel (scope, id) ON DELETE CASCADE
        ) STRICT;
        PRAGMA user_version=1;
      `);
      if (seed) {
        const id = randomUUID();
        db.prepare('INSERT INTO reel VALUES (?,?,?)').run(scope, id, 'Edge of the World');
        const frame = db.prepare('INSERT INTO frame (scope,reel,asset) VALUES (?,?,?)');
        for (const asset of ['dunes', 'headland', 'glacier']) frame.run(scope, id, asset);
      }
    }
    if (version < 2) {
      db.exec(`
        ALTER TABLE frame ADD COLUMN caption TEXT NOT NULL DEFAULT '' CHECK(length(caption) <= 180);
        ALTER TABLE frame ADD COLUMN seconds INTEGER NOT NULL DEFAULT 0 CHECK(seconds = 0 OR seconds BETWEEN 2 AND 30);
        PRAGMA user_version=2;
      `);
    }
    db.exec('COMMIT');
    console.log(version < 2 ? '[database] Schema migrated to 2.' : '[database] Schema already current.');
    console.log(seed && version === 0 ? '[seed] Added the sample reel.' : '[seed] Skipped.');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  const list = db.prepare(`
    SELECT reel.id, reel.title, frame.asset FROM reel LEFT JOIN frame
      ON frame.scope = reel.scope AND frame.reel = reel.id
      WHERE reel.scope = ? ORDER BY reel.rowid, frame.seq
  `);
  return {
    close: () => db.close(),
    snapshot() {
      const reels = new Map();
      for (const row of list.all(scope)) {
        if (!reels.has(row.id)) reels.set(row.id, { id: row.id, title: row.title, ids: [] });
        if (row.asset) reels.get(row.id).ids.push(row.asset);
      }
      return {
        favorites: db.prepare('SELECT asset FROM favorite WHERE scope=? ORDER BY rowid DESC')
          .all(scope).map(({ asset }) => asset),
        reels: [...reels.values()],
      };
    },
    favorite(id, enabled) {
      const sql = enabled ? 'INSERT OR IGNORE INTO favorite VALUES (?,?)'
        : 'DELETE FROM favorite WHERE scope=? AND asset=?';
      db.prepare(sql).run(scope, id);
    },
    createReel(title) {
      const id = randomUUID();
      const result = db.prepare(`INSERT INTO reel SELECT ?,?,?
        WHERE (SELECT count(*) FROM reel WHERE scope=?) < 100`).run(scope, id, title, scope);
      return result.changes > 0 ? id : null;
    },
    removeReel(id) {
      db.prepare('DELETE FROM reel WHERE scope=? AND id=?').run(scope, id);
    },
    cue(reel, asset) {
      return db.prepare('SELECT caption, seconds FROM frame WHERE scope=? AND reel=? AND asset=?')
        .get(scope, reel, asset);
    },
    cues(reel) {
      const rows = db.prepare(`SELECT asset, caption, seconds FROM frame
        WHERE scope=? AND reel=? AND (caption <> '' OR seconds <> 0)`).all(scope, reel);
      return new Map(rows.map(({ asset, caption, seconds }) => [asset, { caption, seconds }]));
    },
    saveCue(reel, asset, caption, seconds) {
      return db.prepare('UPDATE frame SET caption=?, seconds=? WHERE scope=? AND reel=? AND asset=?')
        .run(caption, seconds, scope, reel, asset).changes > 0;
    },
    moveFrame(reel, asset, step) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const rows = db.prepare('SELECT asset, caption, seconds FROM frame WHERE scope=? AND reel=? ORDER BY seq')
          .all(scope, reel);
        const index = rows.findIndex((row) => row.asset === asset);
        if (index < 0 || !rows[index + step]) {
          db.exec('COMMIT');
          return false;
        }
        [rows[index], rows[index + step]] = [rows[index + step], rows[index]];
        db.prepare('DELETE FROM frame WHERE scope=? AND reel=?').run(scope, reel);
        const insert = db.prepare('INSERT INTO frame (scope,reel,asset,caption,seconds) VALUES (?,?,?,?,?)');
        for (const row of rows) insert.run(scope, reel, row.asset, row.caption, row.seconds);
        db.exec('COMMIT');
        return true;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    frame(reel, asset, enabled) {
      if (!enabled) {
        db.prepare('DELETE FROM frame WHERE scope=? AND reel=? AND asset=?').run(scope, reel, asset);
        return true;
      }
      const result = db.prepare(`
        INSERT OR IGNORE INTO frame (scope,reel,asset) SELECT ?,?,?
        WHERE EXISTS (SELECT 1 FROM reel WHERE scope=? AND id=?)
          AND (SELECT count(*) FROM frame WHERE scope=? AND reel=?) < 100
      `).run(scope, reel, asset, scope, reel, scope, reel);
      return result.changes > 0 || !!db.prepare(
        'SELECT 1 FROM frame WHERE scope=? AND reel=? AND asset=?'
      ).get(scope, reel, asset);
    },
  };
}
