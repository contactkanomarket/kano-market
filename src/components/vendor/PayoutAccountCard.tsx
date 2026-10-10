import { useState } from "react";
import { CreditCard, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBanks, useVendorPayoutAccount } from "@/hooks/usePayouts";
import { toast } from "sonner";

/** Bank account vendors are paid into. Verified with the bank through Paystack before saving. */
export function PayoutAccountCard({ vendorId }: { vendorId: string }) {
  const { account, isLoading, saveAccount } = useVendorPayoutAccount(vendorId);
  const [editing, setEditing] = useState(false);
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const showForm = editing || (!isLoading && !account);
  const { data: banks, isLoading: banksLoading } = useBanks(showForm);

  const handleSave = async () => {
    try {
      const result = await saveAccount.mutateAsync({ bank_code: bankCode, account_number: accountNumber });
      toast.success(`Saved: ${result.account_name}, ${result.bank_name}`);
      setEditing(false);
      setAccountNumber("");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not save bank account");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 md:pb-6">
        <CardTitle className="text-base md:text-lg flex items-center gap-2">
          <CreditCard className="h-4 w-4 md:h-5 md:w-5" />
          Payout Account
        </CardTitle>
        <CardDescription className="text-xs md:text-sm">
          You get half of each sale (after commission) when the customer pays, and the rest when
          they confirm delivery.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : !showForm && account ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
              <div className="text-sm">
                <p className="font-medium">{account.account_name}</p>
                <p className="text-muted-foreground">
                  {account.bank_name} · ****{account.account_number.slice(-4)}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-sm">Bank</Label>
                <Select value={bankCode} onValueChange={setBankCode} disabled={banksLoading}>
                  <SelectTrigger>
                    <SelectValue placeholder={banksLoading ? "Loading banks..." : "Select your bank"} />
                  </SelectTrigger>
                  <SelectContent>
                    {banks?.map((bank) => (
                      <SelectItem key={bank.code} value={bank.code}>{bank.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="payout_account_number" className="text-sm">Account Number</Label>
                <Input
                  id="payout_account_number"
                  inputMode="numeric"
                  maxLength={10}
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))}
                  placeholder="10-digit number"
                />
              </div>
            </div>
            <div className="flex gap-2">
              {account && (
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
              <Button
                type="button"
                className="flex-1"
                onClick={handleSave}
                disabled={!bankCode || accountNumber.length !== 10 || saveAccount.isPending}
              >
                {saveAccount.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Checking with your bank...
                  </>
                ) : (
                  "Save bank account"
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
