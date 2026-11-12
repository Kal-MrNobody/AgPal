-- Invariant 3, enforced in the database as well as in code.

-- Append-only: journal entries and postings can never be updated or deleted.
CREATE OR REPLACE FUNCTION agpal_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION agpal_append_only();
--> statement-breakpoint
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION agpal_append_only();
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION agpal_append_only();
--> statement-breakpoint
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON postings
  FOR EACH STATEMENT EXECUTE FUNCTION agpal_append_only();
--> statement-breakpoint

-- Balanced entries: checked at commit, so all postings of an entry are inserted first.
CREATE OR REPLACE FUNCTION agpal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  SELECT currency, sum(amount_minor) AS total, count(*) AS n INTO bad
    FROM postings WHERE entry_id = NEW.entry_id
    GROUP BY currency HAVING sum(amount_minor) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal entry % does not balance in %: off by %', NEW.entry_id, bad.currency, bad.total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION agpal_entry_balanced();
--> statement-breakpoint

-- Posting amounts are never zero and match the account currency.
ALTER TABLE postings ADD CONSTRAINT postings_nonzero CHECK (amount_minor <> 0);
--> statement-breakpoint
ALTER TABLE holds ADD CONSTRAINT holds_positive CHECK (amount_minor > 0);
--> statement-breakpoint

-- Cached balances respect each account's rule.
ALTER TABLE accounts ADD CONSTRAINT accounts_balance_rule CHECK (
  (rule = 'non_negative' AND balance_minor >= 0) OR
  (rule = 'non_positive' AND balance_minor <= 0) OR
  rule = 'any'
);
