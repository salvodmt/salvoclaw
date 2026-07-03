import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'env-and-blocked-hosts',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'").run();
    db.prepare("ALTER TABLE container_configs ADD COLUMN blocked_hosts TEXT NOT NULL DEFAULT '[]'").run();
  },
};
