import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getCaller, serviceClient } from "../_shared/supabase.ts";
import { paystack } from "../_shared/paystack.ts";
import { processPendingPayouts } from "../_shared/payouts.ts";

interface Bank {
  name: string;
  code: string;
  active: boolean;
}

// actions:
//   list_banks                          -> Nigerian banks for the picker
//   save { bank_code, account_number }  -> verify with Paystack, save, send waiting payouts
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const caller = await getCaller(req);
    if (!caller) return json({ success: false, error: 'Please sign in' }, 401);

    const supabase = serviceClient();
    const { data: isVendor } = await supabase.rpc('has_role', { _user_id: caller.id, _role: 'vendor' });
    if (!isVendor) return json({ success: false, error: 'Vendors only' }, 403);

    const { action, bank_code, account_number } = await req.json();

    if (action === 'list_banks') {
      const banks = await paystack<Bank[]>('/bank?country=nigeria&currency=NGN&perPage=200');
      if (!banks.status) throw new Error(banks.message);
      return json({
        success: true,
        banks: banks.data.filter((b) => b.active).map((b) => ({ name: b.name, code: b.code })),
      });
    }

    if (action === 'save') {
      if (!bank_code || !/^\d{10}$/.test(account_number ?? '')) {
        throw new Error('Choose a bank and enter a 10-digit account number');
      }

      const banks = await paystack<Bank[]>('/bank?country=nigeria&currency=NGN&perPage=200');
      const bank = banks.data?.find((b) => b.code === bank_code);
      if (!bank) throw new Error('Unknown bank');

      const resolved = await paystack<{ account_name: string }>(
        `/bank/resolve?account_number=${account_number}&bank_code=${encodeURIComponent(bank_code)}`,
      );
      if (!resolved.status) throw new Error('Could not verify that account number with the bank');

      const recipient = await paystack<{ recipient_code: string }>('/transferrecipient', {
        method: 'POST',
        body: JSON.stringify({
          type: 'nuban',
          name: resolved.data.account_name,
          account_number,
          bank_code,
          currency: 'NGN',
          metadata: { vendor_id: caller.id },
        }),
      });
      if (!recipient.status) throw new Error(recipient.message || 'Could not register the account with Paystack');

      const { error } = await supabase.from('vendor_payout_accounts').upsert({
        vendor_id: caller.id,
        bank_code,
        bank_name: bank.name,
        account_number,
        account_name: resolved.data.account_name,
        recipient_code: recipient.data.recipient_code,
      });
      if (error) throw error;

      // Anything that was waiting for this account can go out now.
      try {
        await processPendingPayouts(supabase, { vendorId: caller.id });
      } catch (payoutError) {
        console.error('Payout after saving account failed; scheduled run will retry:', payoutError);
      }

      return json({ success: true, account_name: resolved.data.account_name, bank_name: bank.name });
    }

    throw new Error('Unknown action');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ success: false, error: message }, 400);
  }
});
