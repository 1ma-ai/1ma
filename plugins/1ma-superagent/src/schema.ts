export const MIGRATIONS: string[] = [
  `CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    last_seen_at INTEGER,
    last_complete_at INTEGER,
    last_attempt_at INTEGER NOT NULL,
    completeness TEXT NOT NULL,
    last_error TEXT
  )`,
  `CREATE TABLE threads_seen (
    server_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT,
    branch TEXT,
    repo TEXT,
    title TEXT,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, thread_id)
  )`,
  `CREATE TABLE works (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    server_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    state TEXT NOT NULL,
    waiting_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (server_id, thread_id)
  )`,
  `CREATE INDEX works_updated ON works (updated_at DESC, id)`,
];
