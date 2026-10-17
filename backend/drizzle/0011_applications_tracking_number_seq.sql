-- A sequence for application tracking numbers.
--
-- The reference number has to be unique across every application, and two
-- submissions can arrive at the same instant, so it is drawn from a sequence
-- rather than counted from existing rows: `nextval` is atomic and a sequence
-- never reuses a value. The unique index on `applications.tracking_number` is a
-- backstop, not the mechanism.
CREATE SEQUENCE "public"."applications_tracking_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
