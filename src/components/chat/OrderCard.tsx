import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CreditCard, Package, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatNaira } from "@/hooks/useVerification";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface ChatOrder {
  id: string;
  status: string;
  payment_status: string | null;
  payment_reference: string | null;
  total: number;
  itemCount: number;
  firstImage: string | null;
}

/** Order status changes after payment; refresh the card now and then. */
const ORDER_CARD_STALE_MS = 30_000;
/** While waiting for payment, check more often so "Pay now" turns into "Paid" quickly. */
const UNPAID_REFRESH_MS = 15_000;

function useChatOrder(orderId: string) {
  return useQuery({
    queryKey: ["chat-order", orderId],
    queryFn: async (): Promise<ChatOrder | null> => {
      const { data, error } = await supabase
        .from("orders")
        .select("id, status, payment_status, payment_reference, total, order_items(quantity, products(product_images(url, is_primary)))")
        .eq("id", orderId)
        .maybeSingle();
      if (error) {
        console.error("[OrderCard] could not load order", { orderId, error });
        throw error;
      }
      if (!data) return null;
      type Item = { quantity: number; products: { product_images: { url: string; is_primary: boolean | null }[] | null } | null };
      const items = (data.order_items ?? []) as Item[];
      const images = items.flatMap((i) => i.products?.product_images ?? []);
      return {
        id: data.id,
        status: data.status,
        payment_status: data.payment_status,
        payment_reference: data.payment_reference,
        total: Number(data.total),
        itemCount: items.reduce((n, i) => n + (i.quantity ?? 0), 0),
        firstImage: (images.find((img) => img.is_primary) ?? images[0])?.url ?? null,
      };
    },
    staleTime: ORDER_CARD_STALE_MS,
    // Coming back from the payment page / app switcher re-checks immediately.
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => (query.state.data && needsPayment(query.state.data) ? UNPAID_REFRESH_MS : false),
  });
}

/** Same rule as the order page: unpaid and no payment started yet. */
function needsPayment(order: ChatOrder): boolean {
  return order.status === "pending_payment" && order.payment_status === "pending" && !order.payment_reference;
}

/**
 * The order Kano Market created for a customer, shown in the chat with a
 * "Pay now" button (or its status once paid).
 */
export function OrderCard({ orderId, mine }: { orderId: string; mine: boolean }) {
  const { data: order, isLoading, isError } = useChatOrder(orderId);

  if (isLoading) return <Skeleton className="my-1 h-24 w-60 max-w-full rounded-2xl" />;
  // Couldn't load it (e.g. it's someone else's order): fall back to a plain link.
  if (isError || !order) {
    return (
      <Link to={`/orders/${orderId}`} className={cn("font-semibold underline", mine ? "text-primary-foreground" : "text-primary")}>
        Open order
      </Link>
    );
  }

  const unpaid = needsPayment(order);
  return (
    <span className={cn("my-1 block w-64 max-w-full overflow-hidden rounded-2xl", mine ? "bg-white/15" : "border bg-background")}>
      <Link to={`/orders/${order.id}`} className="flex gap-3 p-2.5" onClick={(e) => e.stopPropagation()}>
        {order.firstImage ? (
          <img src={order.firstImage} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-xl bg-muted object-cover" />
        ) : (
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Package className="h-6 w-6" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs opacity-70">Order #{order.id.slice(0, 8)}</span>
          <span className="block text-base font-bold">{formatNaira(order.total)}</span>
          <span className="block text-xs opacity-70">
            {order.itemCount} item{order.itemCount === 1 ? "" : "s"} · delivery included
          </span>
        </span>
      </Link>
      {unpaid ? (
        <Link
          to={`/orders/${order.id}`}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center justify-center gap-2 bg-emerald-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 active:bg-emerald-800"
        >
          <CreditCard className="h-4 w-4" /> Pay now
          <span className="flex items-center gap-1 text-[11px] font-normal opacity-90">
            <ShieldCheck className="h-3.5 w-3.5" /> protected
          </span>
        </Link>
      ) : (
        <span className={cn("flex items-center justify-center gap-1.5 border-t py-2 text-xs font-medium animate-in fade-in-0 zoom-in-95 duration-300", mine ? "border-white/20" : "")}>
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          {order.payment_status === "paid" || order.payment_status === "success" ? "Paid" : order.status.replace(/_/g, " ")}
        </span>
      )}
    </span>
  );
}
