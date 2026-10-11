import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ImageOff, ShoppingBag } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatNaira } from "@/hooks/useVerification";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface ChatProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  image: string | null;
  shop: string | null;
}

/** Product cards don't change often; reuse them across chats for a while. */
const PRODUCT_CARD_STALE_MS = 10 * 60 * 1000;

function useChatProduct(productId: string) {
  return useQuery({
    queryKey: ["chat-product", productId],
    queryFn: async (): Promise<ChatProduct | null> => {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, slug, price, product_images(url, is_primary, display_order), vendor:profiles!products_vendor_id_fkey(store_name)")
        .eq("id", productId)
        .maybeSingle();
      if (error) {
        console.error("[ProductCard] could not load product", { productId, error });
        throw error;
      }
      if (!data) return null;
      const images = [...(data.product_images ?? [])].sort(
        (a, b) => Number(!!b.is_primary) - Number(!!a.is_primary) || (a.display_order ?? 0) - (b.display_order ?? 0),
      );
      const vendor = data.vendor as { store_name: string | null } | null;
      return { id: data.id, name: data.name, slug: data.slug, price: Number(data.price), image: images[0]?.url ?? null, shop: vendor?.store_name ?? null };
    },
    staleTime: PRODUCT_CARD_STALE_MS,
  });
}

/**
 * The product a customer wants to buy through Kano Kaftan, shown inside the
 * chat. The support team gets a "Create order" button on it.
 */
export function ProductCard({ productId, mine, onCreateOrder }: { productId: string; mine: boolean; onCreateOrder?: (productId: string) => void }) {
  const { data: product, isLoading } = useChatProduct(productId);

  if (isLoading) return <Skeleton className="mb-1.5 h-20 w-60 max-w-full rounded-2xl" />;
  if (!product) {
    return (
      <p className={cn("mb-1.5 flex items-center gap-2 rounded-2xl px-3 py-2 text-xs", mine ? "bg-white/15" : "bg-muted")}>
        <ImageOff className="h-4 w-4" /> This product is no longer available
      </p>
    );
  }
  return (
    <div className={cn("mb-1.5 w-64 max-w-full overflow-hidden rounded-2xl", mine ? "bg-white/15" : "border bg-background")}>
      <Link to={`/products/${product.slug}`} className="flex gap-3 p-2" onClick={(e) => e.stopPropagation()}>
        {product.image ? (
          <img src={product.image} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-xl bg-muted object-cover" />
        ) : (
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <ShoppingBag className="h-6 w-6" />
          </span>
        )}
        <span className="min-w-0 flex-1 py-0.5">
          <span className="line-clamp-2 text-sm font-semibold leading-tight">{product.name}</span>
          <span className="mt-1 block text-sm font-bold">{formatNaira(product.price)}</span>
          {product.shop && <span className={cn("block truncate text-[11px]", mine ? "text-primary-foreground/70" : "text-muted-foreground")}>by {product.shop}</span>}
        </span>
      </Link>
      {onCreateOrder && (
        <button
          type="button"
          onClick={() => onCreateOrder(product.id)}
          className="flex w-full items-center justify-center gap-1.5 border-t py-2 text-sm font-semibold text-primary hover:bg-muted"
        >
          <ShoppingBag className="h-4 w-4" /> Create order
        </button>
      )}
    </div>
  );
}
