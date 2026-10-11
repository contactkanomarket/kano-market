import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { useRecentlyViewed } from "@/hooks/useRecentlyViewed";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProductImageCarousel, type CarouselImage } from "@/components/products/ProductImageCarousel";

function formatPrice(amount: number): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 0,
  }).format(amount);
}

interface LiveProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  product_images: CarouselImage[];
}

/**
 * Current name, price and photos for the remembered products. The list on the
 * phone only keeps ids; photos saved there could be stale or the wrong picture.
 */
function useLiveProducts(ids: string[]) {
  return useQuery({
    queryKey: ["recently-viewed-products", ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, LiveProduct>> => {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, slug, price, product_images(url, is_primary, display_order)")
        .in("id", ids)
        .eq("is_active", true);
      if (error) {
        console.error("[RecentlyViewed] Failed to load products", error);
        throw error;
      }
      return new Map((data ?? []).map((p) => [p.id, p as LiveProduct]));
    },
  });
}

interface RecentlyViewedProps {
  excludeProductId?: string;
}

export function RecentlyViewed({ excludeProductId }: RecentlyViewedProps) {
  const { recentProducts, clearAll } = useRecentlyViewed();
  const remembered = recentProducts.filter((p) => p.id !== excludeProductId);
  const { data: live, isSuccess } = useLiveProducts(remembered.map((p) => p.id));

  // Once loaded, drop products that were removed or hidden; until then show what we remember.
  const items = remembered
    .filter((p) => !isSuccess || live.has(p.id))
    .map((p) => {
      const current = live?.get(p.id);
      return {
        id: p.id,
        name: current?.name ?? p.name,
        slug: current?.slug ?? p.slug,
        price: current ? Number(current.price) : p.price,
        images: current?.product_images ?? (p.imageUrl ? [{ url: p.imageUrl, is_primary: true }] : []),
      };
    });

  if (items.length === 0) return null;

  return (
    <section className="py-8">
      <div className="container">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Recently Viewed</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={clearAll} className="text-xs text-muted-foreground">
            Clear All
          </Button>
        </div>

        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((product) => (
            <Link key={product.id} to={`/products/${product.slug}`} className="w-[150px] flex-shrink-0 snap-start">
              <Card className="overflow-hidden border-0 shadow-sm transition-shadow hover:shadow-md">
                <div className="aspect-square overflow-hidden bg-muted">
                  <ProductImageCarousel images={product.images} alt={product.name} autoplay swipeable={false} />
                </div>
                <CardContent className="p-3">
                  <p className="truncate text-sm font-medium">{product.name}</p>
                  <p className="mt-1 text-sm font-bold text-primary">{formatPrice(product.price)}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
