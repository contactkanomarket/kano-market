import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  invokeVendorFees,
  isVerifiedNow,
  redirectToCheckout,
  useResetOnPageRestore,
  useVendorFeeProfile,
  useVendorFeeSettings,
} from "@/hooks/useVerification";

export type PlacementKind = "product" | "shop";
export type PlacementStatus = "awaiting_payment" | "active" | "expired" | "cancelled";
/** What the vendor sees, derived from status + dates. */
export type PlacementPhase = "awaiting_payment" | "queued" | "live" | "ended";

export interface FeaturedPlacement {
  id: string;
  kind: PlacementKind;
  product_id: string | null;
  weeks: number;
  amount: number;
  status: PlacementStatus;
  starts_at: string | null;
  ends_at: string | null;
  paid_at: string | null;
  created_at: string;
  product: { name: string; image_url: string | null } | null;
}

export interface PromotableProduct {
  id: string;
  name: string;
  image_url: string;
  featured: boolean;
  featured_until: string | null;
}

interface ProductImageRow {
  url: string;
  is_primary: boolean;
  display_order?: number | null;
}

const PLACEMENT_HISTORY_LIMIT = 50;

function primaryImageUrl(images: ProductImageRow[] | null | undefined): string | null {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  return (sorted.find((img) => img.is_primary) ?? sorted[0]).url;
}

export function placementPhase(placement: FeaturedPlacement, now = Date.now()): PlacementPhase {
  if (placement.status === "awaiting_payment") return "awaiting_payment";
  if (placement.status === "active") {
    const startsAt = placement.starts_at ? new Date(placement.starts_at).getTime() : now;
    const endsAt = placement.ends_at ? new Date(placement.ends_at).getTime() : Infinity;
    if (endsAt <= now) return "ended";
    return startsAt > now ? "queued" : "live";
  }
  return "ended";
}

/** My active products that have a photo (the carousel needs one). */
export function usePromotableProducts(vendorId: string | null) {
  return useQuery({
    queryKey: ["vendor-promotable-products", vendorId],
    queryFn: async (): Promise<PromotableProduct[]> => {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, featured, featured_until, product_images(url, is_primary, display_order)")
        .eq("vendor_id", vendorId!)
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).flatMap((product) => {
        const imageUrl = primaryImageUrl(product.product_images as ProductImageRow[]);
        if (!imageUrl) return [];
        return [{
          id: product.id,
          name: product.name,
          image_url: imageUrl,
          featured: !!product.featured,
          featured_until: product.featured_until,
        }];
      });
    },
    enabled: !!vendorId,
  });
}

/** featured_until for my featured products (null = featured with no end date). */
export function useFeaturedUntil(vendorId: string | null) {
  return useQuery({
    queryKey: ["vendor-featured-until", vendorId],
    queryFn: async (): Promise<Map<string, string | null>> => {
      const { data, error } = await supabase
        .from("products")
        .select("id, featured_until")
        .eq("vendor_id", vendorId!)
        .eq("featured", true);
      if (error) throw error;
      return new Map((data || []).map((row) => [row.id, row.featured_until]));
    },
    enabled: !!vendorId,
  });
}

export function usePromotions(vendorId: string | null) {
  const queryClient = useQueryClient();
  const settingsQuery = useVendorFeeSettings();
  const profileQuery = useVendorFeeProfile(vendorId);

  const placementsQuery = useQuery({
    queryKey: ["vendor-placements", vendorId],
    queryFn: async (): Promise<FeaturedPlacement[]> => {
      const { data, error } = await supabase
        .from("featured_placements")
        .select(
          "id, kind, product_id, weeks, amount, status, starts_at, ends_at, paid_at, created_at, product:products(name, product_images(url, is_primary, display_order))"
        )
        .eq("vendor_id", vendorId!)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(PLACEMENT_HISTORY_LIMIT);
      if (error) throw error;
      return (data || []).map((row) => {
        const product = row.product as { name: string; product_images: ProductImageRow[] } | null;
        return {
          id: row.id,
          kind: row.kind as PlacementKind,
          product_id: row.product_id,
          weeks: row.weeks,
          amount: Number(row.amount),
          status: row.status as PlacementStatus,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          paid_at: row.paid_at,
          created_at: row.created_at,
          product: product ? { name: product.name, image_url: primaryImageUrl(product.product_images) } : null,
        };
      });
    },
    enabled: !!vendorId,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["vendor-placements", vendorId] });
    queryClient.invalidateQueries({ queryKey: ["vendor-fee-profile", vendorId] });
    queryClient.invalidateQueries({ queryKey: ["vendor-promotable-products", vendorId] });
    queryClient.invalidateQueries({ queryKey: ["vendor-featured-until", vendorId] });
    queryClient.invalidateQueries({ queryKey: ["vendor-products", vendorId] });
  }, [queryClient, vendorId]);

  const pay = useMutation({
    mutationFn: async (placementId: string) => {
      const { authorization_url } = await invokeVendorFees<{ authorization_url: string }>({
        action: "pay_featured",
        placement_id: placementId,
      });
      return redirectToCheckout(authorization_url);
    },
  });
  useResetOnPageRestore(pay.reset);

  /** Creates the placement (priced on the server). Free placements come back already active. */
  const request = useMutation({
    mutationFn: async (input: { kind: PlacementKind; weeks: number; productId?: string | null }) => {
      const { data, error } = await supabase.rpc("request_featured_placement", {
        p_kind: input.kind,
        p_weeks: input.weeks,
        p_product_id: input.kind === "product" ? input.productId ?? undefined : undefined,
      });
      if (error) {
        console.error("request_featured_placement failed:", error);
        throw new Error(error.message);
      }
      return data as unknown as { id: string; status: PlacementStatus; amount: number };
    },
    onSettled: refresh,
  });

  return {
    placements: placementsQuery.data ?? [],
    settings: settingsQuery.data ?? null,
    profile: profileQuery.data ?? null,
    isVerified: isVerifiedNow(profileQuery.data),
    isLoading: placementsQuery.isLoading || settingsQuery.isLoading || profileQuery.isLoading,
    error: placementsQuery.error || settingsQuery.error || profileQuery.error,
    request,
    pay,
    refresh,
  };
}
