-- Meeting notes from Fireflies transcriptions
CREATE TABLE IF NOT EXISTS meeting_notes (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         TEXT NOT NULL,
  meeting_id      TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  meeting_date    TIMESTAMPTZ NOT NULL,
  duration_sec    INTEGER,
  participants    TEXT[],
  summary         TEXT,
  raw_transcript  TEXT,
  raw_payload     JSONB,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_user_date
  ON meeting_notes (user_id, meeting_date DESC);

-- Action items extracted from meetings or check-in to-dos
CREATE TABLE IF NOT EXISTS action_items (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      TEXT NOT NULL,
  meeting_id   TEXT REFERENCES meeting_notes(meeting_id) ON DELETE SET NULL,
  text         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'meeting', -- 'meeting' | 'checkin' | 'manual'
  status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'in_progress' | 'done' | 'skipped'
  created_at   TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_action_items_user_status
  ON action_items (user_id, status, created_at DESC);
