import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS qualifications (
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  PRIMARY KEY (actor_id, role)
);

CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0)
);

CREATE TABLE IF NOT EXISTS transfer_times (
  from_zone TEXT NOT NULL,
  to_zone TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes >= 0),
  PRIMARY KEY (from_zone, to_zone)
);

CREATE TABLE IF NOT EXISTS show_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone_id TEXT NOT NULL REFERENCES zones(id),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0)
);

CREATE TABLE IF NOT EXISTS template_roles (
  template_id TEXT NOT NULL REFERENCES show_templates(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  required_count INTEGER NOT NULL CHECK (required_count > 0),
  is_key INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES show_templates(id),
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','started','completed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sessions_starts_at ON sessions(starts_at);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_reservations_session ON reservations(session_id);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  state TEXT NOT NULL DEFAULT 'notified'
    CHECK (state IN ('notified','confirmed','superseded','cancelled')),
  reason TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_assignments_session ON assignments(session_id);
CREATE INDEX IF NOT EXISTS idx_assignments_actor ON assignments(actor_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  assignment_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('assignment_offered','assignment_cancelled','escalation')),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','escalated','cancelled')),
  created_at TEXT NOT NULL,
  deadline TEXT,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, deadline);

CREATE TABLE IF NOT EXISTS unmet_demands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unmet_run ON unmet_demands(run_id);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  operator TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
`;

export const DEFAULT_CONFIG: Record<string, string> = {
  rest_minutes: "15", // 两场演出之间的最短休息
  default_transfer_minutes: "10", // 未配置转场关系时的兜底步行时间
  confirm_timeout_seconds: "300", // 演员确认超时，超时升级值班主管
  min_backup_slack: "1", // 每个岗位至少保留的应急替补人数
  supervisor_actor_id: "duty-supervisor", // 值班主管标识
  sweep_interval_seconds: "15", // 超时清扫周期
};

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT OR IGNORE INTO config(key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) insert.run(k, v);
  return db;
}
