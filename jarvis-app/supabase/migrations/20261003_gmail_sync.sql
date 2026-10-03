-- Tracks which Gmail messages Maya has already surfaced for proactive label monitoring,
-- so the polling cron doesn't re-notify about the same message every run.
CREATE TABLE IF NOT EXISTS gmail_messages_seen (
  message_id    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ DEFAULT now()
);
