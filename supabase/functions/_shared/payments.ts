import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { paystack, type PaystackTransaction } from "./paystack.ts";
import { processPendingPayouts } from "./payouts.ts";

export type ConfirmResult =
  | { status: 'paid' | 'already_processed'; orderId: string; transaction: PaystackTransaction }
  | { status: 'not_successful'; orderId: string | null; transaction: PaystackTransaction };

/**
 * Re-verifies a transaction with Paystack (never trusts the caller's payload),
 * checks it belongs to the order and covers the full amount, then marks the
 * order paid, creates vendor payouts and sends the first half.
 */
export async function confirmOrderPayment(
  supabase: SupabaseClient,
  reference: string,
  expectedOrderId?: string,
): Promise<ConfirmResult> {
  const verify = await paystack<PaystackTransaction>(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (!verify.status) {
    throw new Error(verify.message || 'Failed to verify payment');
  }

  const transaction = verify.data;
  const orderId = typeof transaction.metadata?.order_id === 'string' ? transaction.metadata.order_id : null;

  if (expectedOrderId && orderId !== expectedOrderId) {
    throw new Error('This payment does not belong to this order');
  }

  if (transaction.status !== 'success') {
    return { status: 'not_successful', orderId, transaction };
  }

  if (!orderId) {
    throw new Error('Payment is missing its order reference');
  }

  if (transaction.currency !== 'NGN') {
    throw new Error(`Unexpected currency ${transaction.currency}`);
  }

  const { data: newlyPaid, error } = await supabase.rpc('mark_order_paid', {
    p_order_id: orderId,
    p_reference: transaction.reference,
    p_amount_kobo: transaction.amount,
  });

  if (error) throw error;

  if (!newlyPaid) {
    return { status: 'already_processed', orderId, transaction };
  }

  await sendPaymentNotifications(supabase, orderId, transaction.amount / 100);

  try {
    await processPendingPayouts(supabase, { orderId });
  } catch (payoutError) {
    // The payment itself is recorded; the scheduled payout run will retry.
    console.error('Initial payout failed:', payoutError);
  }

  return { status: 'paid', orderId, transaction };
}

async function sendPaymentNotifications(supabase: SupabaseClient, orderId: string, amount: number) {
  const { data: order } = await supabase.from('orders').select('user_id').eq('id', orderId).single();

  if (order?.user_id) {
    await supabase.from('notifications').insert({
      user_id: order.user_id,
      title: 'Payment Confirmed!',
      message: `Your payment of ₦${amount.toLocaleString()} has been received. Your order is being processed.`,
      type: 'success',
      category: 'payment',
      action_url: `/orders/${orderId}`,
      metadata: { order_id: orderId, amount },
    });
  }

  const { data: items } = await supabase
    .from('order_items')
    .select('vendor_id, product_name, total_price')
    .eq('order_id', orderId);

  const byVendor = new Map<string, { names: string[]; total: number }>();
  for (const item of items ?? []) {
    const entry = byVendor.get(item.vendor_id) ?? { names: [], total: 0 };
    entry.names.push(item.product_name);
    entry.total += Number(item.total_price);
    byVendor.set(item.vendor_id, entry);
  }

  const vendorNotifications = [...byVendor.entries()].map(([vendorId, v]) => {
    const more = v.names.length > 2 ? ` +${v.names.length - 2} more` : '';
    return {
      user_id: vendorId,
      title: 'New Order Received!',
      message: `You have a new order for ${v.names.slice(0, 2).join(', ')}${more}. Total: ₦${v.total.toLocaleString()}`,
      type: 'order',
      category: 'order',
      action_url: '/vendor/orders',
      metadata: { order_id: orderId, total: v.total },
    };
  });

  if (vendorNotifications.length > 0) {
    await supabase.from('notifications').insert(vendorNotifications);
  }

  const { data: admins } = await supabase.from('user_roles').select('user_id').eq('role', 'admin');
  if (admins && admins.length > 0) {
    await supabase.from('notifications').insert(admins.map((admin) => ({
      user_id: admin.user_id,
      title: 'New Paid Order',
      message: `Order #${orderId.slice(0, 8)} has been paid. Amount: ₦${amount.toLocaleString()}`,
      type: 'payment',
      category: 'payment',
      action_url: '/admin/orders',
      metadata: { order_id: orderId, amount },
    })));
  }
}
