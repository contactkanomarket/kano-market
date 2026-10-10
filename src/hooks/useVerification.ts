import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Shared helpers for vendor fees (verification + featured placement)
// ---------------------------------------------------------------------------

export const VERIFICATION_DOCS_BUCKET = "verification-docs";
export const MAX_ID_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const ALLOWED_ID_DOCUMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export type VerificationStatus = "awaiting_payment" | "pending_review" | "approved" | "rejected";
export type IdType = "nin" | "drivers_licence" | "voters_card" | "passport" | "cac";
export type FeeConfirmResult = "applied" | "already_applied" | "not_successful";

export const ID_TYPE_LABELS: Record<IdType, string> = {
  nin: "National ID (NIN)",
  drivers_licence: "Driver's licence",
  voters_card: "Voter's card",
  passport: "International passport",
  cac: "CAC business registration",
};

export interface VendorFeeSettings {
  verification_fee: number;
  verification_period_days: number | null;
  featured_product_weekly_fee: number;
  featured_shop_weekly_fee: number;
  featured_max_weeks: number;
}

export interface VendorFeeProfile {
  is_verified: boolean;
  verified_until: string | null;
  shop_featured_until: string | null;
  avatar_url: string | null;
  store_name: string | null;
  store_slug: string | null;
}

export interface VerificationRequest {
  id: string;
  status: VerificationStatus;
  business_name: string;
  contact_phone: string;
  business_address: string;
  id_type: IdType;
  id_number: string;
  id_document_path: string | null;
  notes: string | null;
  amount: number;
  paid_at: string | null;
  admin_note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface VerificationInput {
  businessName: string;
  contactPhone: string;
  businessAddress: string;
  idType: IdType;
  idNumber: string;
  idDocument: File | null;
  notes: string;
}

interface SubmitVerificationResult {
  request_id: string;
  status: VerificationStatus;
  needs_payment: boolean;
  amount: number;
}

const nairaFormatter = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  minimumFractionDigits: 0,
});

export function formatNaira(amount: number): string {
  return nairaFormatter.format(amount);
}

export function isVerifiedNow(profile: VendorFeeProfile | null | undefined): boolean {
  if (!profile?.is_verified) return false;
  return !profile.verified_until || new Date(profile.verified_until).getTime() > Date.now();
}

/** Reads the human-readable `error` from a vendor-fees response, including non-2xx bodies. */
async function readFunctionError(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      if (typeof body?.error === "string" && body.error) return body.error;
    } catch {
      // Body was not JSON; fall through to the generic message.
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function invokeVendorFees<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vendor-fees", { body });
  if (error) {
    const message = await readFunctionError(error, "Could not reach the payment service. Please try again.");
    console.error("vendor-fees request failed:", body.action, error);
    throw new Error(message);
  }
  if (!data?.success) throw new Error(data?.error || "Request failed. Please try again.");
  return data as T;
}

export function useVendorFeeSettings() {
  return useQuery({
    queryKey: ["vendor-fee-settings"],
    queryFn: async (): Promise<VendorFeeSettings> => {
      const { data, error } = await supabase
        .from("platform_settings")
        .select(
          "verification_fee, verification_period_days, featured_product_weekly_fee, featured_shop_weekly_fee, featured_max_weeks"
        )
        .eq("id", 1)
        .single();
      if (error) throw error;
      return {
        verification_fee: Number(data.verification_fee),
        verification_period_days: data.verification_period_days,
        featured_product_weekly_fee: Number(data.featured_product_weekly_fee),
        featured_shop_weekly_fee: Number(data.featured_shop_weekly_fee),
        featured_max_weeks: data.featured_max_weeks,
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useVendorFeeProfile(vendorId: string | null) {
  return useQuery({
    queryKey: ["vendor-fee-profile", vendorId],
    queryFn: async (): Promise<VendorFeeProfile | null> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("is_verified, verified_until, shop_featured_until, avatar_url, store_name, store_slug")
        .eq("id", vendorId!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { ...data, is_verified: !!data.is_verified } as VendorFeeProfile;
    },
    enabled: !!vendorId,
  });
}

/**
 * Handles the Paystack redirect back (?reference= / ?trxref=): confirms the payment once,
 * shows a toast, runs `onDone`, and strips the payment params from the URL.
 */
export function usePaystackReturn(onDone: () => void, successMessage: { title: string; description: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const handled = useRef(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const reference = searchParams.get("reference") || searchParams.get("trxref");

  useEffect(() => {
    if (!reference || handled.current) return;
    handled.current = true;
    setIsConfirming(true);

    invokeVendorFees<{ result: FeeConfirmResult }>({ action: "confirm", reference })
      .then(({ result }) => {
        if (result === "applied" || result === "already_applied") {
          if (result === "applied") toast(successMessage);
        } else {
          toast({
            title: "Payment not completed",
            description: "Paystack did not confirm this payment. You can try paying again.",
            variant: "destructive",
          });
        }
      })
      .catch((error: unknown) => {
        console.error("Fee payment confirmation failed:", reference, error);
        toast({
          title: "Could not confirm payment",
          description: error instanceof Error ? error.message : "Please refresh the page in a moment.",
          variant: "destructive",
        });
      })
      .finally(() => {
        setIsConfirming(false);
        onDone();
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.delete("reference");
            next.delete("trxref");
            return next;
          },
          { replace: true }
        );
      });
  }, [reference, onDone, setSearchParams, successMessage, toast]);

  return { isConfirming };
}

/**
 * Pay buttons stay busy while the browser leaves for Paystack. If the vendor comes back with the
 * browser's Back button the page may be restored from cache, so clear the busy state then.
 */
export function useResetOnPageRestore(reset: () => void) {
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reset();
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [reset]);
}

export async function redirectToCheckout(authorizationUrl: string): Promise<never> {
  window.location.href = authorizationUrl;
  // Never resolves: keeps the button in its loading state while the browser navigates away.
  return new Promise<never>(() => undefined);
}

function validateIdDocument(file: File): void {
  if (!ALLOWED_ID_DOCUMENT_TYPES.includes(file.type)) {
    throw new Error("Upload a photo (JPG, PNG, WEBP) or a PDF of your ID");
  }
  if (file.size > MAX_ID_DOCUMENT_BYTES) {
    throw new Error("Your ID file is larger than 5 MB. Please upload a smaller photo or PDF");
  }
}

function fileExtension(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && fromName.length <= 5 && fromName !== file.name.toLowerCase()) return fromName;
  return file.type === "application/pdf" ? "pdf" : file.type.split("/")[1] || "bin";
}

async function uploadIdDocument(vendorId: string, file: File): Promise<string> {
  validateIdDocument(file);
  const path = `${vendorId}/${crypto.randomUUID()}.${fileExtension(file)}`;
  const { error } = await supabase.storage
    .from(VERIFICATION_DOCS_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) {
    console.error("ID document upload failed:", error);
    throw new Error(`Could not upload your ID document: ${error.message}`);
  }
  return path;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function useVerification(vendorId: string | null) {
  const queryClient = useQueryClient();
  const settingsQuery = useVendorFeeSettings();
  const profileQuery = useVendorFeeProfile(vendorId);

  const requestQuery = useQuery({
    queryKey: ["vendor-verification", vendorId],
    queryFn: async (): Promise<VerificationRequest | null> => {
      const { data, error } = await supabase
        .from("vendor_verification_requests")
        .select(
          "id, status, business_name, contact_phone, business_address, id_type, id_number, id_document_path, notes, amount, paid_at, admin_note, reviewed_at, created_at"
        )
        .eq("vendor_id", vendorId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? ({ ...data, amount: Number(data.amount) } as VerificationRequest) : null;
    },
    enabled: !!vendorId,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["vendor-verification", vendorId] });
    queryClient.invalidateQueries({ queryKey: ["vendor-fee-profile", vendorId] });
  }, [queryClient, vendorId]);

  const submit = useMutation({
    mutationFn: async (input: VerificationInput): Promise<SubmitVerificationResult> => {
      if (!vendorId) throw new Error("Please sign in again");
      const documentPath = input.idDocument ? await uploadIdDocument(vendorId, input.idDocument) : undefined;

      const { data, error } = await supabase.rpc("submit_verification", {
        p_business_name: input.businessName.trim(),
        p_contact_phone: input.contactPhone.trim(),
        p_business_address: input.businessAddress.trim(),
        p_id_type: input.idType,
        p_id_number: input.idNumber.trim(),
        p_id_document_path: documentPath,
        p_notes: input.notes.trim() || undefined,
      });
      if (error) {
        console.error("submit_verification failed:", error);
        throw new Error(error.message);
      }
      return data as unknown as SubmitVerificationResult;
    },
    onSettled: refresh,
  });

  const pay = useMutation({
    mutationFn: async () => {
      const { authorization_url } = await invokeVendorFees<{ authorization_url: string }>({
        action: "pay_verification",
      });
      return redirectToCheckout(authorization_url);
    },
  });
  useResetOnPageRestore(pay.reset);

  return {
    request: requestQuery.data ?? null,
    profile: profileQuery.data ?? null,
    settings: settingsQuery.data ?? null,
    isVerified: isVerifiedNow(profileQuery.data),
    isLoading: requestQuery.isLoading || profileQuery.isLoading || settingsQuery.isLoading,
    error: requestQuery.error || profileQuery.error || settingsQuery.error,
    submit,
    pay,
    refresh,
  };
}
