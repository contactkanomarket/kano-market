import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useCategories } from "@/hooks/useProducts";
import { Skeleton } from "@/components/ui/skeleton";

export function CategoryGrid() {
  const { data: categories, isLoading } = useCategories();

  return (
    <section className="py-16 md:py-24">
      <div className="container">
        <div className="mb-12 text-center">
          <h2 className="font-display text-3xl font-bold text-primary md:text-4xl">
            Shop by Category
          </h2>
          <p className="mt-4 text-muted-foreground">
            What sellers have listed on Kano Market
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="aspect-[3/4] rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {(categories || []).map((category) => (
              <Link
                key={category.id}
                to={`/products?category=${category.slug}`}
                className={cn(
                  "group relative overflow-hidden rounded-lg",
                  "aspect-[3/4] bg-primary",
                  "transition-transform duration-300 hover:scale-[1.02]"
                )}
              >
                {category.image_url ? (
                  <img
                    src={category.image_url}
                    alt={category.name}
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
                  />
                ) : null}
                <div className="absolute inset-0 bg-gradient-to-t from-primary via-primary/40 to-primary/10" />
                <div className="absolute bottom-0 left-0 right-0 p-6 text-primary-foreground">
                  <h3 className="font-display text-xl font-bold">{category.name}</h3>
                  {category.description ? (
                    <p className="mt-1 text-sm text-primary-foreground/80">{category.description}</p>
                  ) : null}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
