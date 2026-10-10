import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { paystack, type PaystackTransaction } from "./paystack.ts";

export const FEE_PAYMENT_TYPES = ['verification_fee', 'featured_placement'] as const;

export type FeeConfirmResult = 'applied' | 'already_applied' | 'not_successful';

/**
 * Re-checks a vendor fee payment with Paystack (never trusts the caller) and,
 * if it succeeded in full, records it: verification goes to admin review,
 * featured placements start running.
 */
export async function confirmFeePayment(supabase: SupabaseClient, reference: string): Promise<FeeConfirmResult> {
  const verify = await paystack<PaystackTransaction>(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (!verify.status) throw new Error(verify.message || 'Failed to verify payment');

  const transaction = verify.data;
  if (transaction.status !== 'success') return 'not_successful';
  if (transaction.currency !== 'NGN') throw new Error(`Unexpected currency ${transaction.currency}`);

  const { data, error } = await supabase.rpc('confirm_fee_payment', {
    p_reference: transaction.reference,
    p_amount_kobo: transaction.amount,
  });
  if (error) throw error;
  return data as FeeConfirmResult;
}

export function isFeePayment(metadata: Record<string, unknown> | null | undefined): boolean {
  return typeof metadata?.type === 'string' && (FEE_PAYMENT_TYPES as readonly string[]).includes(metadata.type);
}
