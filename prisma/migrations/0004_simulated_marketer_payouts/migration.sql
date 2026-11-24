BEGIN;

CREATE TYPE payout_status AS ENUM ('pending_review', 'confirmed', 'rejected');

CREATE UNIQUE INDEX wallets_id_user_id_role_key ON wallets (id, user_id, role);
ALTER TABLE wallets ADD CONSTRAINT wallets_payout_headroom_check CHECK (
  CASE WHEN role = 'marketer'
    THEN available_balance_syp::numeric + pending_payout_syp <= 9007199254740991
    ELSE pending_payout_syp = 0
  END
);

CREATE TABLE payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketer_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  wallet_role wallet_role NOT NULL DEFAULT 'marketer',
  amount_syp bigint NOT NULL,
  status payout_status NOT NULL DEFAULT 'pending_review',
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at timestamptz(3),
  decided_by_id uuid,
  rejection_reason varchar(500),
  CONSTRAINT payout_requests_marketer_id_fkey FOREIGN KEY (marketer_id)
    REFERENCES users (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT payout_requests_wallet_id_marketer_id_wallet_role_fkey FOREIGN KEY (wallet_id, marketer_id, wallet_role)
    REFERENCES wallets (id, user_id, role) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payout_requests_decided_by_id_fkey FOREIGN KEY (decided_by_id)
    REFERENCES users (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT payout_requests_wallet_role_check CHECK (wallet_role = 'marketer'),
  CONSTRAINT payout_requests_amount_check CHECK (amount_syp BETWEEN 1 AND 9007199254740991),
  CONSTRAINT payout_requests_decision_check CHECK (
    CASE status
      WHEN 'pending_review' THEN decided_at IS NULL AND decided_by_id IS NULL AND rejection_reason IS NULL
      WHEN 'confirmed' THEN decided_at IS NOT NULL AND decided_at >= created_at
        AND decided_by_id IS NOT NULL AND rejection_reason IS NULL
      WHEN 'rejected' THEN decided_at IS NOT NULL AND decided_at >= created_at
        AND decided_by_id IS NOT NULL AND rejection_reason IS NOT NULL AND char_length(rejection_reason) > 0
        AND rejection_reason !~ '^[[:space:]]|[[:space:]]$'
      ELSE false
    END
  )
);

CREATE UNIQUE INDEX payout_requests_id_wallet_id_amount_syp_key
  ON payout_requests (id, wallet_id, amount_syp);
CREATE UNIQUE INDEX payout_requests_one_pending_key
  ON payout_requests (marketer_id) WHERE status = 'pending_review';
CREATE INDEX payout_requests_marketer_id_created_at_id_idx
  ON payout_requests (marketer_id, created_at DESC, id DESC);
CREATE INDEX payout_requests_created_at_id_idx ON payout_requests (created_at DESC, id DESC);
CREATE INDEX payout_requests_status_created_at_id_idx ON payout_requests (status, created_at DESC, id DESC);

ALTER TABLE money_movements ADD COLUMN payout_id uuid;
ALTER TABLE money_movements ADD CONSTRAINT money_movements_payout_id_wallet_id_amount_syp_fkey
  FOREIGN KEY (payout_id, wallet_id, amount_syp) REFERENCES payout_requests (id, wallet_id, amount_syp)
  ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE UNIQUE INDEX money_movements_payout_id_kind_key ON money_movements (payout_id, kind);
CREATE UNIQUE INDEX money_movements_payout_terminal_key ON money_movements (payout_id)
  WHERE kind IN ('payout_release_refund', 'payout_completed');

ALTER TABLE money_movements
  DROP CONSTRAINT money_movements_required_refs_check,
  ADD CONSTRAINT money_movements_required_refs_check CHECK (
    (kind = 'merchant_topup') = (topup_id IS NOT NULL)
    AND (kind IN ('payout_hold', 'payout_release_refund', 'payout_completed')) = (payout_id IS NOT NULL)
    AND CASE kind
      WHEN 'merchant_topup' THEN wallet_id IS NOT NULL AND sale_id IS NULL
      WHEN 'campaign_reserve_lock' THEN campaign_id IS NOT NULL AND wallet_id IS NOT NULL
      WHEN 'campaign_reserve_unlock' THEN campaign_id IS NOT NULL AND wallet_id IS NOT NULL
      WHEN 'sale_reserve_debit' THEN sale_id IS NOT NULL AND campaign_id IS NOT NULL
      WHEN 'marketer_commission_credit' THEN sale_id IS NOT NULL AND wallet_id IS NOT NULL
      WHEN 'customer_cashback_accrual' THEN sale_id IS NOT NULL AND customer_id IS NOT NULL
      WHEN 'customer_cashback_unlock' THEN sale_id IS NOT NULL AND customer_id IS NOT NULL
      WHEN 'platform_net_fee' THEN sale_id IS NOT NULL
      WHEN 'payout_hold' THEN wallet_id IS NOT NULL AND sale_id IS NULL AND campaign_id IS NULL AND customer_id IS NULL
      WHEN 'payout_release_refund' THEN wallet_id IS NOT NULL AND sale_id IS NULL AND campaign_id IS NULL AND customer_id IS NULL
      WHEN 'payout_completed' THEN wallet_id IS NOT NULL AND sale_id IS NULL AND campaign_id IS NULL AND customer_id IS NULL
      ELSE false
    END
  );

COMMIT;
