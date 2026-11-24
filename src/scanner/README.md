# Offer QR settlement

The scanner lookup is read-only. The redeem POST confirms cash collection for one item, as specified by the shared API contract. Amounts use integer hundredths of a new Syrian Pound. Set `CASHBACK_MILESTONE_PURCHASES` and `CASHBACK_MILESTONE_SPEND_SYP` to override the defaults of five purchases and 50,000 minor units.

Settlement uses the idempotency transaction client. The order is idempotency claim, campaign row, selected Offer QR row, shared eligibility locks on merchant and attributed membership, marketer wallet when credited, and customer profile. A final sale invokes the existing campaign close helper in the same transaction. It already holds the campaign lock, which also serializes changes to its sibling passes. Closure expires those passes and locks the merchant wallet when releasing surplus. Merchant and marketer wallets are separate rows even for accounts with both roles.

The Sale row records usage and attribution. The ledger debits commission plus the total platform fee from campaign reserve. It credits the marketer commission, accrues customer cashback, and records the net platform fee. A milestone unlock transfers the full locked customer balance to available cashback, using the triggering sale as its ledger source. A final-sale surplus release uses the existing campaign reserve-unlock movement.

The existing Prisma migration supplies the unique Sale per pass, composite attribution and ownership foreign keys, settlement reconciliation checks, monetary bounds, and the shared idempotency primary key. No schema migration is needed for product Offer QR settlement.
