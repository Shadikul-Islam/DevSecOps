CREATE TABLE IF NOT EXISTS records (
    id          SERIAL PRIMARY KEY,
    email       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_records_pending
    ON records (id)
    WHERE status = 'pending';
