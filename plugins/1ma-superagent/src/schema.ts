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
  `CREATE TABLE pr_links (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    head_repo TEXT,
    head_ref TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    author TEXT,
    pr_state TEXT NOT NULL,
    pr_updated_at INTEGER NOT NULL,
    delivery_server_id TEXT,
    delivery_thread_id TEXT,
    link_kind TEXT,
    claim_problem TEXT,
    claim_checked_at INTEGER,
    branch_hint TEXT,
    provenance_gap INTEGER NOT NULL DEFAULT 0,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (repo, number)
  )`,
  `CREATE TABLE pr_provenance (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (repo, number, provider_id, model)
  )`,
  `CREATE TABLE repo_cursors (
    repo TEXT PRIMARY KEY,
    pulls_seen_until INTEGER NOT NULL
  )`,
];
