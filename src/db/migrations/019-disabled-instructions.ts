import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'disabled-instructions',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN disabled_instructions TEXT NOT NULL DEFAULT '[]'").run();
  },
};
