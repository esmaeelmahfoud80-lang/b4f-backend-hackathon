import type { Prisma } from '../generated/prisma/client';

export async function lockMarketerWallet(tx: Prisma.TransactionClient, marketerId: string) {
  const [wallet] = await tx.$queryRaw<{ id: string; availableBalanceSyp: bigint; pendingPayoutSyp: bigint }[]>`
    SELECT id, available_balance_syp AS "availableBalanceSyp", pending_payout_syp AS "pendingPayoutSyp"
    FROM wallets WHERE user_id = ${marketerId}::uuid AND role = 'marketer' FOR UPDATE
  `;
  if (!wallet) throw new Error('Marketer wallet is missing.');
  return wallet;
}
