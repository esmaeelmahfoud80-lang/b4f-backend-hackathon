# PostgreSQL schema notes for Step 02C

The Prisma schema preserves the [ERD](../../docs/handoff/DATABASE_ERD.md) names in PostgreSQL. User roles come from the customer, marketer, and admin flags and the presence of a merchant profile. A user can hold several roles at once. The wallet enum only covers the two roles with wallets. The SQL examples below describe constraints implemented in [0001_init_mvp](migrations/0001_init_mvp/migration.sql). [0002_merchant_topup_balance_snapshot](migrations/0002_merchant_topup_balance_snapshot/migration.sql) adds the nullable post-credit balance and its monetary check.

Dedicated monetary columns use PostgreSQL `bigint` and store integer hundredths of one new Syrian Pound. The exact decimal `commission_value` stores an integer minor-unit amount for fixed commissions and a percentage otherwise. The existing bounds, column names and Prisma mappings continue to apply. Verified old-SYP integers carry over unchanged. For any amount with uncertain historical denomination, check its source records and reconcile related balances and ledger entries before making a correction. The schema retains the ERD’s campaign and attribution variants. This step covers the 13 core models, with voucher and payout tables and their ledger links deferred.

## Active Offer QR uniqueness

Prisma 7.10.1 represents both ERD partial unique indexes through the `partialIndexes` preview feature. The initial migration contains both predicates.

```sql
CREATE UNIQUE INDEX offer_qr_passes_active_marketer_key
  ON offer_qr_passes (campaign_id, customer_id, campaign_marketer_id)
  WHERE status = 'active' AND campaign_marketer_id IS NOT NULL;

CREATE UNIQUE INDEX offer_qr_passes_active_direct_key
  ON offer_qr_passes (campaign_id, customer_id)
  WHERE status = 'active' AND campaign_marketer_id IS NULL;
```

## CHECK constraints in the initial migration

Prisma 7 cannot declare these PostgreSQL `CHECK` constraints in its schema. The initial migration defines them after the table definitions. These checks enforce the [contract’s monetary bounds](../../docs/handoff/API_CONTRACT.md#monetary-limits-and-precision), phone format, and row-level pricing and settlement invariants.

```sql
ALTER TABLE users
  ADD CONSTRAINT users_phone_format_check
  CHECK (phone ~ '^09[0-9]{8}$');

ALTER TABLE merchant_profiles
  ADD CONSTRAINT merchant_profiles_credit_limit_syp_check
  CHECK (credit_limit_syp BETWEEN 0 AND 9007199254740991);

ALTER TABLE customer_profiles
  ADD CONSTRAINT customer_profiles_amounts_check
  CHECK (
    verified_purchase_count >= 0
    AND milestone_purchase_count >= 0
    AND milestone_spend_syp BETWEEN 0 AND 9007199254740991
    AND locked_cashback_syp BETWEEN 0 AND 9007199254740991
    AND available_cashback_syp BETWEEN 0 AND 9007199254740991
  );

ALTER TABLE wallets
  ADD CONSTRAINT wallets_syp_balances_check
  CHECK (
    available_balance_syp BETWEEN 0 AND 9007199254740991
    AND pending_payout_syp BETWEEN 0 AND 9007199254740991
  );

ALTER TABLE merchant_topups
  ADD CONSTRAINT merchant_topups_amount_syp_check
  CHECK (amount_syp BETWEEN 1 AND 9007199254740991);

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_amounts_check
  CHECK (
    original_price_syp BETWEEN 1 AND 9007199254740991
    AND max_sales_volume_syp BETWEEN 1 AND 9007199254740991
    AND worst_case_reserve_syp BETWEEN 0 AND 9007199254740991
    AND locked_budget_syp BETWEEN 0 AND worst_case_reserve_syp
    AND (status <> 'ended' OR locked_budget_syp = 0)
  ),
  ADD CONSTRAINT campaigns_pricing_check
  CHECK (
    discount_percent BETWEEN 0 AND 100
    AND (
      (commission_type = 'fixed'
        AND commission_value BETWEEN 0 AND 9007199254740991
        AND commission_value = trunc(commission_value))
      OR (commission_type = 'percentage' AND commission_value BETWEEN 0 AND 100)
    )
    AND (
      (campaign_type = 'product'
        AND original_price_syp IS NOT NULL AND max_items IS NOT NULL AND max_items > 0)
      OR (campaign_type = 'store_discount'
        AND max_sales_volume_syp IS NOT NULL AND commission_type = 'percentage')
    )
  );

ALTER TABLE campaign_marketers
  ADD CONSTRAINT campaign_marketers_referral_status_check
  CHECK (referral_code IS NULL OR status = 'approved');

ALTER TABLE sales
  ADD CONSTRAINT sales_amounts_check
  CHECK (
    quantity > 0
    AND original_amount_syp BETWEEN 1 AND 9007199254740991
    AND customer_paid_cash_syp BETWEEN 1 AND 9007199254740991
    AND marketer_commission_syp BETWEEN 0 AND 9007199254740991
    AND platform_total_fee_syp BETWEEN 0 AND 9007199254740991
    AND customer_cashback_syp BETWEEN 0 AND 9007199254740991
    AND platform_net_fee_syp BETWEEN 0 AND 9007199254740991
    AND total_deducted_reserve_syp BETWEEN 0 AND 9007199254740991
  ),
  ADD CONSTRAINT sales_settlement_split_check
  CHECK (
    platform_total_fee_syp = platform_net_fee_syp + customer_cashback_syp
    AND total_deducted_reserve_syp = marketer_commission_syp + platform_total_fee_syp
  ),
  ADD CONSTRAINT sales_attribution_source_check
  CHECK (
    (attribution_source = 'marketer' AND campaign_marketer_id IS NOT NULL)
    OR (attribution_source = 'merchant_direct' AND campaign_marketer_id IS NULL
      AND marketer_commission_syp = 0)
  );

ALTER TABLE money_movements
  ADD CONSTRAINT money_movements_amount_syp_check
  CHECK (amount_syp BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT money_movements_required_refs_check
  CHECK (
    (kind = 'merchant_topup') = (topup_id IS NOT NULL)
    AND CASE kind
      WHEN 'merchant_topup' THEN wallet_id IS NOT NULL AND sale_id IS NULL
      WHEN 'campaign_reserve_lock' THEN campaign_id IS NOT NULL AND wallet_id IS NOT NULL
      WHEN 'campaign_reserve_unlock' THEN campaign_id IS NOT NULL AND wallet_id IS NOT NULL
      WHEN 'sale_reserve_debit' THEN sale_id IS NOT NULL AND campaign_id IS NOT NULL
      WHEN 'marketer_commission_credit' THEN sale_id IS NOT NULL AND wallet_id IS NOT NULL
      WHEN 'customer_cashback_accrual' THEN sale_id IS NOT NULL AND customer_id IS NOT NULL
      WHEN 'customer_cashback_unlock' THEN sale_id IS NOT NULL AND customer_id IS NOT NULL
      WHEN 'platform_net_fee' THEN sale_id IS NOT NULL
      ELSE false
    END
  );
```

## Sale and Offer QR attribution

The schema’s composite foreign keys tie referral clicks and Offer QRs to memberships in their own campaign. They also tie each sale to its pass’s campaign and customer and its campaign’s merchant. The unique `offer_qr_pass_id` still allows only one sale per pass. A null membership is reserved for direct merchant attribution.

Attribution can be null. PostgreSQL’s default composite foreign-key matching skips the check when a referencing component is null. The initial migration installs the following triggers to compare attribution null-safely and keep the pass’s issued attribution immutable as its status changes.

```sql
CREATE FUNCTION prevent_offer_qr_attribution_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_marketer_id IS DISTINCT FROM OLD.campaign_marketer_id THEN
    RAISE EXCEPTION 'Offer QR marketer attribution is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER offer_qr_attribution_immutable
  BEFORE UPDATE OF campaign_marketer_id ON offer_qr_passes
  FOR EACH ROW EXECUTE FUNCTION prevent_offer_qr_attribution_change();

CREATE FUNCTION enforce_sale_pass_attribution()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pass_marketer_id uuid;
BEGIN
  SELECT campaign_marketer_id INTO pass_marketer_id
  FROM offer_qr_passes
  WHERE id = NEW.offer_qr_pass_id;

  IF NOT FOUND OR NEW.campaign_marketer_id IS DISTINCT FROM pass_marketer_id THEN
    RAISE EXCEPTION 'Sale marketer attribution must match its Offer QR'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_pass_attribution_check
  BEFORE INSERT OR UPDATE OF offer_qr_pass_id, campaign_marketer_id ON sales
  FOR EACH ROW EXECUTE FUNCTION enforce_sale_pass_attribution();
```

## Transaction rules

- Lock the campaign before checking eligibility and issuing or reusing an Offer QR. At settlement, lock the campaign and pass before the affected balances. Copy the sale’s attribution from the locked pass and campaign, and conditionally transition the pass from active to redeemed.
- The ledger checks require a source for each movement. In the same transaction, verify that wallet ownership and role match the top-up merchant, campaign merchant, or attributed marketer as appropriate. Verify that campaign and customer references on sale-derived entries match the sale. Use the sale that crosses the milestone as the source of its cashback unlock.
- Commit balance changes, ledger movements, and any idempotency result together. At closure, capture the remaining reserve under the campaign lock, credit and record its release once, and set the campaign status to ended and its locked reserve to zero in the same update. Final-sale settlement performs this closure inside the sale transaction before saving the replay response.
