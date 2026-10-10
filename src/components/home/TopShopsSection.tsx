import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { ShopCard } from "@/components/shop/ShopCard";
import { useShops } from "@/hooks/useShops";

export function TopShopsSection() {
  const { data: shops, isLoading } = useShops("", 10);

  if (!isLoading && !shops?.length) return null;

  return (
    <section className="py-6">
      <div className="mb-4 flex items-center justify-between px-4">
        <h2 className="text-lg font-semibold text-foreground">Top Shops</h2>
        <Link to="/shops" className="text-sm font-medium text-primary">
          View All
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto px-4 pb-2">
        {isLoading
          ? [1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-56 flex-shrink-0 rounded-xl" />)
          : shops!.map((shop) => <ShopCard key={shop.id} shop={shop} compact />)}
      </div>
    </section>
  );
}
