-- Termini Dental, migration 007: a visit is "completed" only when there is a report of it (audit H5).
--
-- Owner's rule 6: every visit that took place has a written report. The application used to let a visit be
-- marked completed with one press and no report, and then showed it as done. From now on the database holds
-- the rule, so that no route, no later code and no hand at a console can break it:
--
--   - an appointment may have the status 'completed' only if a row in visit_reports exists for it;
--   - the report of a completed appointment cannot be deleted from under it;
--   - an appointment that has a report cannot be 'no_show': the report says what was done at the visit, and
--     "did not come" beside it would be two records that contradict each other.
--
-- Both are checked at the END of the transaction (deferred), because the two rows are written one after the
-- other: saving a report writes the report and then marks the visit; a restored backup and the demo data
-- write the appointments first and their reports afterwards. Halfway through, the rule may be untrue; at
-- commit it must hold.
--
-- Two transactions at the same moment (one deletes a report, the other marks its appointment completed) each
-- see the other's row as it was. So the check first locks the appointment's row: the second of the two then
-- waits for the first to finish, sees what it did, and is refused.
--
-- Existing data: if any appointment is already completed without a report, this migration stops and changes
-- nothing. It does not invent a report (that would be a made-up clinical record) and it does not change the
-- status on its own (that would say the patient did not come). Which of the two is true, a person decides.

DO $$
DECLARE n integer; ids text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ' ORDER BY id) FILTER (WHERE rn <= 20)
    INTO n, ids
    FROM (SELECT a.id, row_number() OVER (ORDER BY a.id) AS rn
            FROM appointments a
           WHERE a.status = 'completed' AND NOT EXISTS (SELECT 1 FROM visit_reports r WHERE r.appointment_id = a.id)) missing;
  IF n > 0 THEN
    RAISE EXCEPTION '% appointment(s) are marked completed without a visit report (ids: %). Nothing was changed. For each, either write its report or set it back to booked or no_show, then migrate again.', n, ids;
  END IF;
  SELECT count(*), string_agg(id::text, ', ' ORDER BY id) FILTER (WHERE rn <= 20)
    INTO n, ids
    FROM (SELECT a.id, row_number() OVER (ORDER BY a.id) AS rn
            FROM appointments a
           WHERE a.status = 'no_show' AND EXISTS (SELECT 1 FROM visit_reports r WHERE r.appointment_id = a.id)) contradicting;
  IF n > 0 THEN
    RAISE EXCEPTION '% appointment(s) are marked no_show although they have a visit report (ids: %). Nothing was changed. For each, decide which is true (the patient came: set it to completed; the patient did not come: the report does not belong there), then migrate again.', n, ids;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION completed_needs_a_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE appointment integer; current_status text; has_report boolean;
BEGIN
  IF TG_TABLE_NAME = 'appointments' THEN
    appointment := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    appointment := OLD.appointment_id;
  ELSE
    appointment := NEW.appointment_id;
  END IF;
  -- One at a time per appointment: whoever else is changing this appointment or its report finishes first,
  -- and what they did is seen below.
  PERFORM 1 FROM appointments a WHERE a.id = appointment FOR UPDATE;
  -- Judged on what is true now, at the end of the transaction, not on the row as it was when it changed.
  SELECT a.status INTO current_status FROM appointments a WHERE a.id = appointment;
  has_report := EXISTS (SELECT 1 FROM visit_reports r WHERE r.appointment_id = appointment);
  IF current_status = 'completed' AND NOT has_report THEN
    RAISE EXCEPTION 'appointment % cannot be completed without a visit report', appointment USING ERRCODE = 'TD002';
  END IF;
  IF current_status = 'no_show' AND has_report THEN
    RAISE EXCEPTION 'appointment % has a visit report and cannot be marked as not attended', appointment USING ERRCODE = 'TD003';
  END IF;
  RETURN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'appointments_completed_needs_a_report') THEN
    CREATE CONSTRAINT TRIGGER appointments_completed_needs_a_report
      AFTER INSERT OR UPDATE OF status ON appointments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION completed_needs_a_report();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'visit_reports_stay_with_completed') THEN
    CREATE CONSTRAINT TRIGGER visit_reports_stay_with_completed
      AFTER DELETE ON visit_reports
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION completed_needs_a_report();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'visit_reports_not_for_no_show') THEN
    CREATE CONSTRAINT TRIGGER visit_reports_not_for_no_show
      AFTER INSERT ON visit_reports
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION completed_needs_a_report();
  END IF;
END $$;
