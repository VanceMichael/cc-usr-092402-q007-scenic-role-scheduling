import Database from "better-sqlite3";
import { DEFAULT_RULES, Rules } from "./types.js";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS qualifications (
  id TEXT PRIMARY KEY,
  actorId TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  validFrom TEXT NOT NULL,
  validUntil TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS transfers (
  fromZone TEXT NOT NULL,
  toZone TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  PRIMARY KEY (fromZone, toZone)
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zoneId TEXT NOT NULL REFERENCES zones(id),
  durationMinutes INTEGER NOT NULL,
  requirements TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  templateId TEXT NOT NULL REFERENCES templates(id),
  startTs TEXT NOT NULL,
  endTs TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(startTs);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  visitorGroup TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES actors(id),
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  locked INTEGER NOT NULL DEFAULT 0,
  trace TEXT NOT NULL DEFAULT '[]',
  createdTs TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_assignments_actor ON assignments(actorId, status);
CREATE INDEX IF NOT EXISTS idx_assignments_session ON assignments(sessionId, status);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  assignmentId TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES actors(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  deadlineTs TEXT NOT NULL,
  createdTs TEXT NOT NULL,
  resolvedTs TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, deadlineTs);
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  notificationId TEXT NOT NULL REFERENCES notifications(id),
  supervisor TEXT NOT NULL,
  reason TEXT NOT NULL,
  createdTs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  createdTs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS unmet_requirements (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  role TEXT,
  needed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  createdTs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unmet_session ON unmet_requirements(sessionId);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  entityType TEXT NOT NULL,
  entityId TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
`;

export function openDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedSettings(db);
  return db;
}

function seedSettings(db: DB): void {
  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(DEFAULT_RULES)) {
    insert.run(key, String(value));
  }
}

export function getRules(db: DB): Rules {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    minRestMinutes: Number(map.get("minRestMinutes") ?? DEFAULT_RULES.minRestMinutes),
    maxSessionsPerDay: Number(map.get("maxSessionsPerDay") ?? DEFAULT_RULES.maxSessionsPerDay),
    reservePerRole: Number(map.get("reservePerRole") ?? DEFAULT_RULES.reservePerRole),
    confirmTimeoutSec: Number(map.get("confirmTimeoutSec") ?? DEFAULT_RULES.confirmTimeoutSec),
    dutySupervisor: map.get("dutySupervisor") ?? DEFAULT_RULES.dutySupervisor,
  };
}

export function updateRules(db: DB, patch: Partial<Rules>): Rules {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!(key in DEFAULT_RULES)) continue;
    upsert.run(key, String(value));
  }
  return getRules(db);
}
