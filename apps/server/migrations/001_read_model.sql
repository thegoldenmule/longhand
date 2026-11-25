-- Longhand ledger service: the Postgres read model.
--
-- Every table except session_tokens is derived from the Durable Streams and is
-- rebuilt by `pnpm --filter @longhand/server rebuild`. Times copied from commits
-- are kept as the exact ISO strings that were hashed and signed.

CREATE TABLE projects (
  project_id   text PRIMARY KEY,
  account_id   text NOT NULL,
  title        text NOT NULL,
  stream_path  text NOT NULL,
  created_at   text NOT NULL,          -- serverTime of ProjectCreated
  head_seq     integer NOT NULL,
  head_hash    text NOT NULL,
  updated_at   text NOT NULL           -- serverTime of the head commit
);
CREATE INDEX projects_account_idx ON projects (account_id);

CREATE TABLE commits (
  project_id   text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  commit_id    text NOT NULL,
  type         text NOT NULL,
  actor_kind   text NOT NULL,
  actor_id     text NOT NULL,
  session_id   text NOT NULL,
  document_id  text,
  client_time  text NOT NULL,
  server_time  text NOT NULL,
  hash         text NOT NULL,
  body         jsonb NOT NULL,
  PRIMARY KEY (project_id, seq),
  UNIQUE (project_id, commit_id)
);
CREATE INDEX commits_document_idx ON commits (project_id, document_id, seq);

CREATE TABLE witnesses (
  project_id   text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  hash         text NOT NULL,
  server_time  text NOT NULL,
  signature    text NOT NULL,
  key_id       text NOT NULL,
  PRIMARY KEY (project_id, seq)
);

-- The folded ProjectState at head_seq: a read cache for fast first paint. The
-- service always re-folds the stream before it accepts writes (the fold's internal
-- state is not serializable through @longhand/ledger's public API).
CREATE TABLE snapshots (
  project_id   text PRIMARY KEY REFERENCES projects (project_id) ON DELETE CASCADE,
  head_seq     integer NOT NULL,
  head_hash    text NOT NULL,
  state        jsonb NOT NULL
);

CREATE TABLE documents (
  project_id   text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  document_id  text NOT NULL,
  kind         text NOT NULL,
  area         text NOT NULL,
  title        text NOT NULL,
  parent_id    text,
  archived     boolean NOT NULL,
  version      integer NOT NULL,
  created_seq  integer NOT NULL,
  content_seq  integer NOT NULL,
  updated_seq  integer NOT NULL,
  PRIMARY KEY (project_id, document_id)
);

-- One row per annotation-layer record (comments, suggestions, proposals, …).
CREATE TABLE annotations (
  project_id     text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  collection     text NOT NULL,
  annotation_id  text NOT NULL,
  seq            integer NOT NULL,
  status         text,
  document_id    text,
  session_id     text,
  body           jsonb NOT NULL,
  PRIMARY KEY (project_id, collection, annotation_id)
);
CREATE INDEX annotations_session_idx ON annotations (project_id, session_id);

-- Agent sessions as the fold sees them.
CREATE TABLE agent_sessions (
  session_id      text NOT NULL,
  project_id      text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  kind            text NOT NULL,
  request_id      text,
  thread_id       text,
  model           text NOT NULL,
  status          text NOT NULL,
  started_seq     integer NOT NULL,
  ended_seq       integer,
  failure_reason  text,
  PRIMARY KEY (project_id, session_id)
);

-- Per-session bearer tokens (SHA-256 of the secret). Ephemeral by design: secrets
-- never enter the streams, so `rebuild` empties this table, and sessions do not
-- survive a restart anyway (the service fails them on startup).
CREATE TABLE session_tokens (
  session_id   text PRIMARY KEY,
  project_id   text NOT NULL,
  account_id   text NOT NULL,
  kind         text NOT NULL,
  token_hash   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);
