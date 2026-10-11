import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BadgeCheck, Sparkles, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProducts } from "@/hooks/useProducts";
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from "@/components/ui/carousel";
import { useEffect, useState, useCallback } from "react";
import Autoplay from "embla-carousel-autoplay";

import kaftanBlue from "@/assets/products/kaftan-blue.jpg";
import kaftanWhite from "@/assets/products/kaftan-white.jpg";
import kaftanGrey from "@/assets/products/kaftan-grey.jpg";
import { VerifiedBadge } from "@/components/shop/VerifiedBadge";

const fallbackSlides = [
  {
    image: kaftanBlue,
    tag: "New Collection",
    title: "RAMADAN/EID\nCOLLECTION",
    description: "Discover premium agbada and kaftan sets crafted for the season of celebration.",
  },
  {
    image: kaftanWhite,
    tag: "Premium Quality",
    title: "ELEGANT\nKAFTAN",
    description: "Handcrafted with the finest fabrics for a look that commands respect.",
  },
  {
    image: kaftanGrey,
    tag: "Best Sellers",
    title: "CLASSIC\nAGBADA",
    description: "Timeless designs that blend tradition with contemporary style.",
  },
];

const HERO_PRODUCT_LIMIT = 5;

interface HeroSlide {
  image: string;
  tag: string;
  title: string;
  description: string;
  slug?: string;
  shopName?: string | null;
  shopVerified?: boolean;
  shopTier?: string | null;
  sponsored?: boolean;
}

export function MobileHero() {
  const { t } = useTranslation();
  const { data } = useProducts({ featured: true, limit: HERO_PRODUCT_LIMIT });
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(0);
  const [autoplayPlugin] = useState(() => 
    Autoplay({ delay: 4000, stopOnInteraction: false })
  );

  const slides: HeroSlide[] = data?.products?.length
    ? data.products.map((product, index) => ({
        image:
          product.product_images?.find((img) => img.is_primary)?.url ||
          product.product_images?.[0]?.url ||
          fallbackSlides[index % fallbackSlides.length].image,
        tag: t("home.sponsored", "Sponsored"),
        title: product.name?.toUpperCase().replace(/ /g, '\n') || "FEATURED\nPRODUCT",
        description: product.description?.slice(0, 80) || `Premium ${product.category?.name || 'attire'} from ${product.vendor?.store_name || 'our vendors'}.`,
        slug: product.slug,
        shopName: product.vendor?.store_name,
        shopVerified: product.vendor?.is_verified,
        shopTier: product.vendor?.verification_tier,
        sponsored: true,
      }))
    : fallbackSlides;

  const onSelect = useCallback(() => {
    if (!api) return;
    setCurrent(api.selectedScrollSnap());
  }, [api]);

  useEffect(() => {
    if (!api) return;
    
    onSelect();
    api.on("select", onSelect);
    api.on("reInit", onSelect);
    
    return () => {
      api.off("select", onSelect);
      api.off("reInit", onSelect);
    };
  }, [api, onSelect]);

  const scrollTo = useCallback((index: number) => {
    api?.scrollTo(index);
  }, [api]);

  return (
    <section className="relative mx-4 mt-3 overflow-hidden rounded-xl">
      <Carousel 
        opts={{ loop: true }} 
        plugins={[autoplayPlugin]}
        className="w-full"
        setApi={setApi}
      >
        <CarouselContent>
          {slides.map((slide, index) => (
            <CarouselItem key={index}>
              <div className="relative aspect-[4/5] sm:aspect-[16/9] w-full">
                <img
                  src={slide.image}
                  alt={slide.title}
                  className="h-full w-full object-cover object-top"
                />
                
                {/* Overlay Gradient */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
                
                {/* Content */}
                <div className="absolute inset-0 flex flex-col justify-end p-4 sm:p-6">
                  {/* Tag */}
                  <span className="mb-1.5 inline-flex w-fit items-center gap-1 rounded-md bg-primary px-2.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                    {slide.sponsored && <Sparkles className="h-3 w-3" aria-hidden="true" />}
                    {slide.tag}
                  </span>
                  
                  {/* Title */}
                  <h1 className="font-display text-xl font-bold leading-tight text-white sm:text-2xl whitespace-pre-line">
                    {slide.title}
                  </h1>
                  
                  {/* Shop name (product slides only) */}
                  {slide.shopName && (
                    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-white/90">
                      <Store className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{slide.shopName}</span>
                      {slide.shopVerified && (
                        <VerifiedBadge className="h-3.5 w-3.5" tier={slide.shopTier} label={slide.shopTier === "gold" ? t("home.topShop", "Top seller") : t("home.verifiedShop", "Verified shop")} />
                      )}
                    </p>
                  )}

                  {/* Description - hidden on mobile for compactness */}
                  <p className="mt-1.5 max-w-[240px] text-xs leading-relaxed text-white/85 line-clamp-2 hidden sm:block">
                    {slide.description}
                  </p>
                  
                  {/* CTA Button */}
                  <Button 
                    size="sm" 
                    variant="secondary"
                    className="mt-3 w-fit rounded-full px-5 text-xs font-medium"
                    asChild
                  >
                    <Link to={slide.slug ? `/products/${slide.slug}` : "/products"}>
                      {slide.slug ? t("home.viewProduct", "View Product") : t("home.shopNow", "Shop Now")}
                    </Link>
                  </Button>
                </div>
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
    </section>
  );
}