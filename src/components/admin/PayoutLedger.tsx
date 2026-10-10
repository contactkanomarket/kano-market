import { format } from "date-fns";
import { Loader2, RefreshCw, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { payoutStatusLabels, useAdminPayouts } from "@/hooks/usePayouts";
import { toast } from "sonner";

function formatPrice(amount: number): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);
}

export function PayoutLedger() {
  const { payouts, isLoading, runPayouts, retryPayout } = useAdminPayouts();

  const handleRun = async () => {
    try {
      const result = await runPayouts.mutateAsync();
      toast.success(
        `Sent ${result.sent}, failed ${result.failed}, waiting for bank details ${result.waitingForBankAccount}`,
      );
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Payout run failed");
    }
  };

  const handleRetry = async (payoutId: string) => {
    try {
      await retryPayout.mutateAsync(payoutId);
      toast.success("Payout queued again");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not retry payout");
    }
  };

  const commission = payouts.filter((p) => p.tranche === 1).reduce((sum, p) => sum + Number(p.commission_amount), 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Payout ledger</CardTitle>
          <CardDescription>
            Every vendor payment, in two parts per order. Commission earned (latest 200): {formatPrice(commission)}
          </CardDescription>
        </div>
        <Button size="sm" onClick={handleRun} disabled={runPayouts.isPending}>
          {runPayouts.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
          Send due payouts
        </Button>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : payouts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payouts yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Part</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payouts.map((payout) => (
                <TableRow key={payout.id}>
                  <TableCell>{payout.store_name || payout.vendor_id.slice(0, 8)}</TableCell>
                  <TableCell className="font-mono text-xs">#{payout.order_id.slice(0, 8)}</TableCell>
                  <TableCell>{payout.tranche}/2</TableCell>
                  <TableCell className="text-right">{formatPrice(Number(payout.amount))}</TableCell>
                  <TableCell>
                    <Badge variant={payout.status === "failed" || payout.status === "on_hold" ? "destructive" : "secondary"}>
                      {payoutStatusLabels[payout.status]}
                    </Badge>
                    {payout.failure_reason && (
                      <p className="mt-1 max-w-[220px] text-xs text-muted-foreground">{payout.failure_reason}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {format(new Date(payout.paid_at ?? payout.created_at), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>
                    {payout.status === "failed" && (
                      <Button size="sm" variant="outline" onClick={() => handleRetry(payout.id)} disabled={retryPayout.isPending}>
                        <RefreshCw className="mr-1 h-3 w-3" />
                        Retry
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
