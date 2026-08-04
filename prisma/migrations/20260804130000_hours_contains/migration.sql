-- =============================================================================================
-- hours_contains() — the working/opening-hours predicate used by findCandidates (§6.7).
--
-- It lives in SQL, not in TypeScript, because the candidate set must be computed in ONE
-- set-returning query against current data. Pulling technicians into the app to filter them by
-- hours would mean a round trip per resource and a candidate set already stale by the time it
-- is used.
--
-- Semantics are pinned by §6.7 and mirrored by `src/availability/hours.ts`:
--   * hours are LOCAL wall-clock ranges per weekday; the window is a pair of UTC instants
--   * the whole window must fit inside ONE contiguous range — no straddling a lunch gap
--   * ranges are half-open [open, close): ending exactly at close is fine, starting at close is not
--   * a window crossing into another local day is rejected (ending exactly at midnight is not
--     "another day" — it is this day's closing boundary)
-- =============================================================================================

CREATE OR REPLACE FUNCTION hours_contains(
    hours       JSONB,
    win_start   TIMESTAMPTZ,
    win_end     TIMESTAMPTZ,
    tz          TEXT
) RETURNS BOOLEAN
-- STABLE, not IMMUTABLE: `AT TIME ZONE` depends on the timezone database, which can be updated.
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
    local_start TIMESTAMP;
    local_end   TIMESTAMP;
    dow_key     TEXT;
    rng         JSONB;
    open_min    INT;
    close_min   INT;
    start_min   INT;
    end_min     INT;
BEGIN
    IF hours IS NULL THEN
        RETURN false;
    END IF;

    -- UTC instant -> local wall clock. This direction is single-valued, so no DST ambiguity can
    -- arise here; the gap/overlap problem belongs to the local->UTC enumeration in
    -- GET /availability (§6.7).
    local_start := win_start AT TIME ZONE tz;
    local_end   := win_end   AT TIME ZONE tz;

    dow_key := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])
                   [EXTRACT(DOW FROM local_start)::INT + 1];

    IF hours -> dow_key IS NULL OR jsonb_typeof(hours -> dow_key) <> 'array'
       OR jsonb_array_length(hours -> dow_key) = 0 THEN
        RETURN false;   -- closed that weekday
    END IF;

    IF local_start::DATE <> local_end::DATE
       AND local_end <> (local_start::DATE + 1)::TIMESTAMP THEN
        RETURN false;   -- crosses midnight into a different weekday bucket
    END IF;

    start_min := EXTRACT(HOUR FROM local_start)::INT * 60
               + EXTRACT(MINUTE FROM local_start)::INT;
    -- Derive the end from elapsed minutes so an end at local midnight reads as 1440, not 0.
    end_min   := start_min + (EXTRACT(EPOCH FROM (win_end - win_start)) / 60)::INT;

    FOR rng IN SELECT * FROM jsonb_array_elements(hours -> dow_key) LOOP
        open_min  := split_part(rng ->> 0, ':', 1)::INT * 60 + split_part(rng ->> 0, ':', 2)::INT;
        close_min := split_part(rng ->> 1, ':', 1)::INT * 60 + split_part(rng ->> 1, ':', 2)::INT;

        -- One range must contain the WHOLE window; a window spanning two ranges falls through.
        IF start_min >= open_min AND start_min < close_min AND end_min <= close_min THEN
            RETURN true;
        END IF;
    END LOOP;

    RETURN false;
END;
$$;

COMMENT ON FUNCTION hours_contains(JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) IS
    'True when [win_start, win_end) fits inside a single contiguous range of the weekday it '
    'starts on, per the local wall-clock hours spec. See docs/system-design.md §6.7.';
