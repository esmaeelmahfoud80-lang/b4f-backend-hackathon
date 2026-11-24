BEGIN;

-- A pending balance predating payout requests has no auditable source.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wallets WHERE pending_payout_syp <> 0) THEN
    RAISE EXCEPTION 'Cannot enable simulated payouts: existing pending payout balances require reconciliation.'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TYPE money_movement_kind ADD VALUE 'payout_hold';
ALTER TYPE money_movement_kind ADD VALUE 'payout_release_refund';
ALTER TYPE money_movement_kind ADD VALUE 'payout_completed';

-- PostgreSQL must commit enum values before the next migration can reference them.
COMMIT;
