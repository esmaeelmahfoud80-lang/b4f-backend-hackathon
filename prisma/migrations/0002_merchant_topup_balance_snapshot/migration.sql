BEGIN;

ALTER TABLE "merchant_topups"
  ADD COLUMN "merchant_new_available_balance_syp" BIGINT,
  ADD CONSTRAINT "merchant_topups_post_credit_balance_check" CHECK (
    "merchant_new_available_balance_syp" IS NULL OR
    "merchant_new_available_balance_syp" BETWEEN "amount_syp" AND 9007199254740991
  );

-- Match the demo seed's committed marker, exact opening top-ups and ledger entries.
-- The scanner opening credit is the balance before the demo reserve lock.
WITH demo_opening_credit (topup_id, merchant_id, movement_id, wallet_id, amount_syp) AS (
  VALUES
    ('aff111a7-e000-4000-8000-000000000022'::uuid, 'aff111a7-e000-4000-8000-000000000002'::uuid,
     'aff111a7-e000-4000-8000-000000000032'::uuid, 'aff111a7-e000-4000-8000-000000000012'::uuid, 100000::bigint),
    ('aff111a7-e000-4000-8000-000000000025'::uuid, 'aff111a7-e000-4000-8000-000000000005'::uuid,
     'aff111a7-e000-4000-8000-000000000035'::uuid, 'aff111a7-e000-4000-8000-000000000015'::uuid, 435000::bigint)
)
UPDATE "merchant_topups" AS topup
SET "merchant_new_available_balance_syp" = fixture.amount_syp
FROM demo_opening_credit AS fixture
JOIN "money_movements" AS movement ON movement.id = fixture.movement_id
  AND movement.topup_id = fixture.topup_id AND movement.wallet_id = fixture.wallet_id
  AND movement.kind = 'merchant_topup' AND movement.amount_syp = fixture.amount_syp
JOIN "wallets" AS wallet ON wallet.id = fixture.wallet_id
  AND wallet.user_id = fixture.merchant_id AND wallet.role = 'merchant'
WHERE topup.id = fixture.topup_id AND topup.merchant_id = fixture.merchant_id
  AND topup.admin_id = 'aff111a7-e000-4000-8000-000000000001'::uuid
  AND topup.amount_syp = fixture.amount_syp
  AND topup.payment_method = 'cash' AND topup.reference_note = 'Simulated demo opening credit'
  AND EXISTS (
    SELECT 1 FROM "idempotency_records" AS seed
    WHERE seed.actor_id = topup.admin_id AND seed.operation = 'demo.seed.v1'
      AND seed.request_key = 'aff111a7-e000-4000-8000-000000000090'::uuid
      AND seed.request_fingerprint = 'demo-seed-v1' AND seed.response_status = 201
  );

CREATE INDEX "merchant_topups_created_at_id_idx" ON "merchant_topups"("created_at" DESC, "id" DESC);

COMMIT;
