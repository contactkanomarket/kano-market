import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAdminPayouts } from "@/hooks/usePayouts";
import { toast } from "sonner";

function formatPrice(amount: number): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);
}

export function DisputesPanel() {
  const { disputes, isLoading, resolveDispute } = useAdminPayouts();

  const resolve = async (orderId: string, outcome: "release" | "refund") => {
    try {
      await resolveDispute.mutateAsync({ orderId, outcome });
      toast.success(outcome === "release" ? "Vendor's remaining payment released" : "Vendor's remaining payment cancelled");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not resolve dispute");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Open disputes</CardTitle>
        <CardDescription>
          The vendor's second payment is frozen until you decide. "Side with customer" cancels it; refund the
          customer from your Paystack dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : disputes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open disputes.</p>
        ) : (
          disputes.map((dispute) => (
            <div key={dispute.id} className="rounded-lg border p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-mono">#{dispute.id.slice(0, 8)}</span>
                <span>{formatPrice(dispute.total)}</span>
              </div>
              <p className="text-sm">{dispute.dispute_reason}</p>
              <p className="text-xs text-muted-foreground">
                {dispute.customer_email}
                {dispute.disputed_at && ` · ${format(new Date(dispute.disputed_at), "MMM d, h:mm a")}`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => resolve(dispute.id, "release")} disabled={resolveDispute.isPending}>
                  Pay the vendor
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" disabled={resolveDispute.isPending}>
                      Side with customer
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Side with the customer?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The vendor's remaining payment will be cancelled and the order marked cancelled. The first
                        half has already been paid to the vendor. Refund the customer from Paystack separately.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => resolve(dispute.id, "refund")}>Confirm</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
