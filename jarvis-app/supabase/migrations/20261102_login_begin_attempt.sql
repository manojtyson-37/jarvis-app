-- Atomic check-and-record for the Maya login lockout. Additive only: creates one function, touches no rows.
-- A transaction-scoped advisory lock serialises all callers, so the count and the insert cannot interleave
-- and a parallel burst of guesses cannot all read a stale count. Blocked attempts are NOT recorded, so
-- hammering a locked account never extends the lockout.
CREATE OR REPLACE FUNCTION login_begin_attempt(p_ip TEXT, p_window_secs INT, p_ip_max INT, p_global_max INT)
RETURNS TABLE (locked BOOLEAN, retry_after_sec INT)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_since   TIMESTAMPTZ;
  v_ip_n    INT;
  v_glob_n  INT;
  v_ip_at   TIMESTAMPTZ;
  v_glob_at TIMESTAMPTZ;
  v_until   TIMESTAMPTZ;
BEGIN
  -- Two-key form (fixed app id + name hash) so it cannot collide with other advisory-lock users in this database.
  PERFORM pg_advisory_xact_lock(7710, hashtext('maya_login_attempts'));
  -- clock_timestamp(), not now(): now() is the transaction start and goes stale while waiting on the lock.
  v_since := clock_timestamp() - make_interval(secs => p_window_secs);

  SELECT count(*) INTO v_ip_n   FROM login_attempts WHERE ip = p_ip AND created_at > v_since;
  SELECT count(*) INTO v_glob_n FROM login_attempts WHERE created_at > v_since;

  IF v_ip_n >= p_ip_max THEN
    SELECT created_at INTO v_ip_at FROM login_attempts
      WHERE ip = p_ip AND created_at > v_since ORDER BY created_at ASC OFFSET (v_ip_n - p_ip_max) LIMIT 1;
  END IF;
  IF v_glob_n >= p_global_max THEN
    SELECT created_at INTO v_glob_at FROM login_attempts
      WHERE created_at > v_since ORDER BY created_at ASC OFFSET (v_glob_n - p_global_max) LIMIT 1;
  END IF;

  v_until := GREATEST(v_ip_at, v_glob_at) + make_interval(secs => p_window_secs);
  IF v_ip_at IS NOT NULL OR v_glob_at IS NOT NULL THEN
    RETURN QUERY SELECT TRUE, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_until - clock_timestamp())))::INT);
    RETURN;
  END IF;

  INSERT INTO login_attempts (ip) VALUES (p_ip);
  RETURN QUERY SELECT FALSE, 0;
END;
$$;

-- Only the server-side service-role key may call it (the public anon key must not be able to burn attempts).
REVOKE ALL ON FUNCTION login_begin_attempt(TEXT, INT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION login_begin_attempt(TEXT, INT, INT, INT) TO service_role;
