-- Tracks which Freshdesk tickets Maya has already surfaced, so the polling cron
-- doesn't re-notify about the same ticket every run.
CREATE TABLE IF NOT EXISTS freshdesk_tickets_seen (
  ticket_id   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ DEFAULT now()
);
