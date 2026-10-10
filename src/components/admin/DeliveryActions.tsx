import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface DeliveryActionsProps {
  orderId: string;
  paymentStatus: string;
  escrowStatus: string | null;
}

/** Record the delivery company + pickup code, then confirm delivery to release the vendor's second half. */
export function DeliveryActions({ orderId, paymentStatus, escrowStatus }: DeliveryActionsProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [company, setCompany] = useState("");
  const [code, setCode] = useState("");
  const [tracking, setTracking] = useState("");
  const [hasDelivery, setHasDelivery] = useState(false);
  const [busy, setBusy] = useState<"save" | "deliver" | null>(null);

  useEffect(() => {
    if (!open) return;
    supabase
      .from("order_deliveries")
      .select("delivery_company, pickup_code, tracking_reference")
      .eq("order_id", orderId)
      .maybeSingle()
      .then(({ data }) => {
        setHasDelivery(!!data);
        setCompany(data?.delivery_company ?? "");
        setCode(data?.pickup_code ?? "");
        setTracking(data?.tracking_reference ?? "");
      });
  }, [open, orderId]);

  if (paymentStatus !== "paid" || escrowStatus !== "held") return null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-orders"] });
    queryClient.invalidateQueries({ queryKey: ["admin-payout-ledger"] });
  };

  const handleSave = async () => {
    setBusy("save");
    const { error } = await supabase.rpc("admin_set_delivery", {
      p_order_id: orderId,
      p_delivery_company: company,
      p_pickup_code: code,
      p_tracking_reference: tracking || null,
    });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setHasDelivery(true);
    toast.success("Saved. The customer has been sent the pickup code.");
    refresh();
  };

  const handleDelivered = async () => {
    setBusy("deliver");
    const { error } = await supabase.rpc("admin_mark_delivered", { p_order_id: orderId });
    if (error) {
      setBusy(null);
      toast.error(error.message);
      return;
    }
    // Send the vendor's second half straight away (the hourly run would also pick it up).
    await supabase.functions.invoke("process-payouts", { body: {} }).catch(() => undefined);
    setBusy(null);
    toast.success("Marked delivered. The vendor's remaining payment is on its way.");
    setOpen(false);
    refresh();
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Truck className="mr-1 h-3.5 w-3.5" />
        Delivery
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delivery for order #{orderId.slice(0, 8)}</DialogTitle>
            <DialogDescription>
              Enter the code the delivery company gave you. The customer sees it on their order and gives it to the
              rider. The vendor never sees it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor={`company-${orderId}`}>Delivery company</Label>
              <Input id={`company-${orderId}`} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. GIG Logistics" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`code-${orderId}`}>Pickup code</Label>
              <Input id={`code-${orderId}`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the delivery company" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`tracking-${orderId}`}>Tracking reference (optional)</Label>
              <Input id={`tracking-${orderId}`} value={tracking} onChange={(e) => setTracking(e.target.value)} />
            </div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={handleSave} disabled={!company.trim() || !code.trim() || busy !== null}>
              {busy === "save" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {hasDelivery ? "Update & notify customer" : "Save & send code to customer"}
            </Button>
            <Button onClick={handleDelivered} disabled={!hasDelivery || busy !== null}>
              {busy === "deliver" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Mark delivered (code confirmed)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
