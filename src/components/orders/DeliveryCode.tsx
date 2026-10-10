import { useQuery } from "@tanstack/react-query";
import { KeyRound, Truck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

/** Pickup code from the delivery company: the customer gives it to the rider on arrival. */
export function DeliveryCode({ orderId }: { orderId: string }) {
  const { data: delivery } = useQuery({
    queryKey: ["order-delivery", orderId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("order_deliveries")
        .select("delivery_company, pickup_code, tracking_reference")
        .eq("order_id", orderId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  if (!delivery) return null;

  return (
    <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Truck className="h-4 w-4 text-primary" />
        On its way with {delivery.delivery_company}
        {delivery.tracking_reference && (
          <span className="font-normal text-muted-foreground">· Ref {delivery.tracking_reference}</span>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-background p-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <KeyRound className="h-4 w-4" />
          Pickup code
        </div>
        <span className="font-mono text-2xl font-bold tracking-widest">{delivery.pickup_code}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Only give this code to the rider when your parcel is in your hands. Don't share it with anyone else, including
        the seller.
      </p>
    </div>
  );
}
