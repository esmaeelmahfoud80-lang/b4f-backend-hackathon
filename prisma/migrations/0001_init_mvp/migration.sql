BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "merchant_verification_status" AS ENUM ('pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "wallet_role" AS ENUM ('merchant', 'marketer');

-- CreateEnum
CREATE TYPE "topup_payment_method" AS ENUM ('cash', 'sham_cash', 'syriatel_cash', 'bank_transfer');

-- CreateEnum
CREATE TYPE "campaign_type" AS ENUM ('product', 'store_discount');

-- CreateEnum
CREATE TYPE "commission_type" AS ENUM ('fixed', 'percentage');

-- CreateEnum
CREATE TYPE "join_mode" AS ENUM ('open', 'approval_required');

-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('active', 'ended');

-- CreateEnum
CREATE TYPE "join_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "offer_qr_status" AS ENUM ('active', 'redeemed', 'expired');

-- CreateEnum
CREATE TYPE "sale_attribution_source" AS ENUM ('marketer', 'merchant_direct');

-- CreateEnum
CREATE TYPE "money_movement_kind" AS ENUM ('merchant_topup', 'campaign_reserve_lock', 'campaign_reserve_unlock', 'sale_reserve_debit', 'marketer_commission_credit', 'customer_cashback_accrual', 'customer_cashback_unlock', 'platform_net_fee');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" VARCHAR(10) NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_customer" BOOLEAN NOT NULL DEFAULT false,
    "is_marketer" BOOLEAN NOT NULL DEFAULT false,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_profiles" (
    "user_id" UUID NOT NULL,
    "shop_name" TEXT NOT NULL,
    "shop_details" TEXT NOT NULL,
    "contract_reference" TEXT,
    "verification_status" "merchant_verification_status" NOT NULL DEFAULT 'pending',
    "credit_limit_syp" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "merchant_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "user_id" UUID NOT NULL,
    "verified_purchase_count" INTEGER NOT NULL DEFAULT 0,
    "milestone_purchase_count" INTEGER NOT NULL DEFAULT 0,
    "milestone_spend_syp" BIGINT NOT NULL DEFAULT 0,
    "locked_cashback_syp" BIGINT NOT NULL DEFAULT 0,
    "available_cashback_syp" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "role" "wallet_role" NOT NULL,
    "available_balance_syp" BIGINT NOT NULL DEFAULT 0,
    "pending_payout_syp" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_topups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "amount_syp" BIGINT NOT NULL,
    "payment_method" "topup_payment_method" NOT NULL,
    "reference_note" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_topups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "campaign_type" "campaign_type" NOT NULL,
    "product_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "original_price_syp" BIGINT,
    "discount_percent" DECIMAL(5,2) NOT NULL,
    "commission_type" "commission_type" NOT NULL,
    "commission_value" DECIMAL(18,2) NOT NULL,
    "join_mode" "join_mode" NOT NULL,
    "max_items" INTEGER,
    "max_sales_volume_syp" BIGINT,
    "worst_case_reserve_syp" BIGINT NOT NULL,
    "locked_budget_syp" BIGINT NOT NULL,
    "direct_referral_code" VARCHAR,
    "status" "campaign_status" NOT NULL DEFAULT 'active',
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_marketers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "marketer_id" UUID NOT NULL,
    "status" "join_status" NOT NULL,
    "referral_code" VARCHAR,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_marketers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_clicks" (
    "id" BIGSERIAL NOT NULL,
    "campaign_id" UUID NOT NULL,
    "campaign_marketer_id" UUID,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_qr_passes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "campaign_marketer_id" UUID,
    "customer_id" UUID NOT NULL,
    "qr_token" VARCHAR NOT NULL,
    "pass_code" VARCHAR NOT NULL,
    "status" "offer_qr_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemed_at" TIMESTAMPTZ(3),

    CONSTRAINT "offer_qr_passes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "offer_qr_pass_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "campaign_marketer_id" UUID,
    "customer_id" UUID NOT NULL,
    "attribution_source" "sale_attribution_source" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "original_amount_syp" BIGINT NOT NULL,
    "customer_paid_cash_syp" BIGINT NOT NULL,
    "marketer_commission_syp" BIGINT NOT NULL,
    "platform_total_fee_syp" BIGINT NOT NULL,
    "customer_cashback_syp" BIGINT NOT NULL,
    "platform_net_fee_syp" BIGINT NOT NULL,
    "total_deducted_reserve_syp" BIGINT NOT NULL,
    "scanned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "money_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" UUID,
    "campaign_id" UUID,
    "sale_id" UUID,
    "topup_id" UUID,
    "customer_id" UUID,
    "kind" "money_movement_kind" NOT NULL,
    "amount_syp" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "money_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "actor_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "request_key" UUID NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("actor_id","operation","request_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_refresh_token_hash_key" ON "user_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_role_key" ON "wallets"("user_id", "role");

-- CreateIndex
CREATE INDEX "merchant_topups_merchant_id_created_at_id_idx" ON "merchant_topups"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_direct_referral_code_key" ON "campaigns"("direct_referral_code");

-- CreateIndex
CREATE INDEX "campaigns_merchant_id_created_at_id_idx" ON "campaigns"("merchant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "campaigns_status_created_at_id_idx" ON "campaigns"("status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "campaigns_status_ends_at_idx" ON "campaigns"("status", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_id_merchant_id_key" ON "campaigns"("id", "merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_marketers_referral_code_key" ON "campaign_marketers"("referral_code");

-- CreateIndex
CREATE INDEX "campaign_marketers_marketer_id_requested_at_id_idx" ON "campaign_marketers"("marketer_id", "requested_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_marketers_campaign_id_marketer_id_key" ON "campaign_marketers"("campaign_id", "marketer_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_marketers_id_campaign_id_key" ON "campaign_marketers"("id", "campaign_id");

-- CreateIndex
CREATE INDEX "referral_clicks_campaign_id_campaign_marketer_id_idx" ON "referral_clicks"("campaign_id", "campaign_marketer_id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_qr_passes_qr_token_key" ON "offer_qr_passes"("qr_token");

-- CreateIndex
CREATE UNIQUE INDEX "offer_qr_passes_pass_code_key" ON "offer_qr_passes"("pass_code");

-- CreateIndex
CREATE INDEX "offer_qr_passes_campaign_id_status_idx" ON "offer_qr_passes"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "offer_qr_passes_id_campaign_id_customer_id_key" ON "offer_qr_passes"("id", "campaign_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_qr_passes_active_marketer_key" ON "offer_qr_passes"("campaign_id", "customer_id", "campaign_marketer_id") WHERE (status = 'active' AND campaign_marketer_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "offer_qr_passes_active_direct_key" ON "offer_qr_passes"("campaign_id", "customer_id") WHERE (status = 'active' AND campaign_marketer_id IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "sales_offer_qr_pass_id_key" ON "sales"("offer_qr_pass_id");

-- CreateIndex
CREATE INDEX "sales_campaign_id_idx" ON "sales"("campaign_id");

-- CreateIndex
CREATE INDEX "sales_campaign_marketer_id_idx" ON "sales"("campaign_marketer_id");

-- CreateIndex
CREATE INDEX "sales_customer_id_scanned_at_id_idx" ON "sales"("customer_id", "scanned_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sales_offer_qr_pass_id_campaign_id_customer_id_key" ON "sales"("offer_qr_pass_id", "campaign_id", "customer_id");

-- CreateIndex
CREATE INDEX "money_movements_wallet_id_created_at_id_idx" ON "money_movements"("wallet_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "money_movements_campaign_id_idx" ON "money_movements"("campaign_id");

-- CreateIndex
CREATE INDEX "money_movements_sale_id_idx" ON "money_movements"("sale_id");

-- CreateIndex
CREATE INDEX "money_movements_topup_id_idx" ON "money_movements"("topup_id");

-- CreateIndex
CREATE INDEX "money_movements_customer_id_kind_idx" ON "money_movements"("customer_id", "kind");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_topups" ADD CONSTRAINT "merchant_topups_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_topups" ADD CONSTRAINT "merchant_topups_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_marketers" ADD CONSTRAINT "campaign_marketers_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_marketers" ADD CONSTRAINT "campaign_marketers_marketer_id_fkey" FOREIGN KEY ("marketer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_clicks" ADD CONSTRAINT "referral_clicks_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_clicks" ADD CONSTRAINT "referral_clicks_campaign_marketer_id_campaign_id_fkey" FOREIGN KEY ("campaign_marketer_id", "campaign_id") REFERENCES "campaign_marketers"("id", "campaign_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "offer_qr_passes" ADD CONSTRAINT "offer_qr_passes_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_qr_passes" ADD CONSTRAINT "offer_qr_passes_campaign_marketer_id_campaign_id_fkey" FOREIGN KEY ("campaign_marketer_id", "campaign_id") REFERENCES "campaign_marketers"("id", "campaign_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "offer_qr_passes" ADD CONSTRAINT "offer_qr_passes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_offer_qr_pass_id_campaign_id_customer_id_fkey" FOREIGN KEY ("offer_qr_pass_id", "campaign_id", "customer_id") REFERENCES "offer_qr_passes"("id", "campaign_id", "customer_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_campaign_id_merchant_id_fkey" FOREIGN KEY ("campaign_id", "merchant_id") REFERENCES "campaigns"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_campaign_marketer_id_campaign_id_fkey" FOREIGN KEY ("campaign_marketer_id", "campaign_id") REFERENCES "campaign_marketers"("id", "campaign_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_movements" ADD CONSTRAINT "money_movements_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_movements" ADD CONSTRAINT "money_movements_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_movements" ADD CONSTRAINT "money_movements_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_movements" ADD CONSTRAINT "money_movements_topup_id_fkey" FOREIGN KEY ("topup_id") REFERENCES "merchant_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_movements" ADD CONSTRAINT "money_movements_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer_profiles"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Application invariants that Prisma 7 cannot declare as CHECK constraints.

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

-- Match nullable marketer attribution and preserve issued pass attribution.

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

COMMIT;
