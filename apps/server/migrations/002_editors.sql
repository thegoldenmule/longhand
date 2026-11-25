-- Named editors: each account's roster of AI editors (name, brief, lenses,
-- intensity, canned questions). These are account settings, not ledger events,
-- so they are NOT derived from the streams and `rebuild` leaves them alone. A
-- feedback request records the editor it asked (id, name, brief, lenses,
-- intensity) in the project's ledger, so the ledger never depends on this table.

CREATE TABLE editors (
  account_id   text NOT NULL,
  editor_id    text NOT NULL,
  position     integer NOT NULL,
  profile      jsonb NOT NULL,         -- EditorProfileInput (schema `editors`)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, editor_id)
);
CREATE INDEX editors_account_idx ON editors (account_id, position);

-- One row per account whose roster has been seeded with the starter editors, so
-- an account that deletes every editor keeps an empty roster (until it resets).
CREATE TABLE editor_rosters (
  account_id   text PRIMARY KEY,
  seeded_at    timestamptz NOT NULL DEFAULT now()
);
