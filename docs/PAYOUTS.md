# Two-part vendor payouts

## How money moves

1. The customer pays Kano Kaftan through Paystack. `place_order()` prices the cart on the server, so
   the browser can't change what's charged.
2. When Paystack confirms the payment (webhook or the return-to-site check), `mark_order_paid()`
   checks the amount and creates two payouts per vendor in the order:
   - **Part 1**: half of (vendor's items − commission). Sent right away.
   - **Part 2**: the other half. Held until the customer taps **I received my order**, or
     automatically `auto_release_days` after the vendor marks the order shipped.
3. If the customer taps **Report a problem** before part 2 is released, it's frozen until an admin
   picks **Pay the vendor** or **Side with customer** (Admin → Finance → Disputes). Siding with the
   customer cancels part 2; refund the customer from the Paystack dashboard.

Commission and the auto-release window are set in Admin → Settings and apply to new orders.
Shipping fees stay with the platform.

## One-time setup

### Paystack
- Turn on **Transfers** for the business (requires a verified Paystack business).
- Turn **off OTP for transfers** (Settings → Preferences). Otherwise every transfer waits for an OTP
  and the payout shows "Paystack is asking for an OTP".
- Set the webhook URL to `https://<project-ref>.supabase.co/functions/v1/payment-webhook`.
- Transfers are paid from your Paystack balance. Keep it funded, or payouts fail with
  "insufficient balance" and can be retried from Admin → Finance.

### Supabase function secrets
```
supabase secrets set PAYSTACK_SECRET_KEY=sk_live_... CRON_SECRET=<long random string>
```

### Hourly payout run
`process-payouts` releases due second halves, sends anything pending, and re-checks transfers stuck
in "Sending". Schedule it hourly. In the Supabase SQL editor (enable the `pg_cron` and `pg_net`
extensions first):

```sql
select vault.create_secret('<same CRON_SECRET>', 'cron_secret');

select cron.schedule(
  'process-payouts',
  '7 * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/process-payouts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Admins can also run it on demand with **Send due payouts** in Admin → Finance.

### Vendors
Each vendor adds their bank account in Vendor → Settings → Payout Account. The account is checked
with the bank through Paystack. Payouts created before a vendor adds an account wait and go out as
soon as it's saved.
