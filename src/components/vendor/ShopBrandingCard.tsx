import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ImagePlus, Link2, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_BANNER_BYTES = 5 * 1024 * 1024;

function toSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40);
}

/** Shop short link (/shop/<slug>) and cover banner. Saved independently of the main settings form. */
export function ShopBrandingCard({ vendorId }: { vendorId: string }) {
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [isSavingSlug, setIsSavingSlug] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    supabase
      .from("profiles")
      .select("store_slug, store_banner_url")
      .eq("id", vendorId)
      .single()
      .then(({ data }) => {
        setSavedSlug(data?.store_slug ?? null);
        setSlug(data?.store_slug ?? "");
        setBannerUrl(data?.store_banner_url ?? null);
      });
  }, [vendorId]);

  const cleanSlug = slug.replace(/-+$/, "");
  const slugValid = SLUG_PATTERN.test(cleanSlug) && cleanSlug.length >= 3 && cleanSlug.length <= 40;

  const handleSaveSlug = async () => {
    setIsSavingSlug(true);
    try {
      const { data, error } = await supabase
        .from("profiles")
        .update({ store_slug: cleanSlug })
        .eq("id", vendorId)
        .select("store_slug")
        .single();
      if (error) {
        throw new Error(error.code === "23505" ? "That link is taken. Try another." : error.message);
      }
      setSavedSlug(data.store_slug);
      setSlug(data.store_slug ?? "");
      toast.success("Shop link updated");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not update link");
    } finally {
      setIsSavingSlug(false);
    }
  };

  const handleBanner = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image");
      return;
    }
    if (file.size > MAX_BANNER_BYTES) {
      toast.error("Image must be under 5 MB");
      return;
    }

    setIsUploading(true);
    try {
      const path = `${vendorId}/banner.${file.name.split(".").pop()?.toLowerCase() || "jpg"}`;
      const { error: uploadError } = await supabase.storage.from("product-images").upload(path, file, { upsert: true });
      if (uploadError) throw uploadError;

      const { data } = supabase.storage.from("product-images").getPublicUrl(path);
      const url = `${data.publicUrl}?t=${Date.now()}`;
      const { error } = await supabase.from("profiles").update({ store_banner_url: url }).eq("id", vendorId);
      if (error) throw error;

      setBannerUrl(url);
      toast.success("Banner updated");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 md:pb-6">
        <CardTitle className="text-base md:text-lg flex items-center gap-2">
          <Link2 className="h-4 w-4 md:h-5 md:w-5" />
          Shop link & banner
        </CardTitle>
        <CardDescription className="text-xs md:text-sm">
          Share your shop link with customers on WhatsApp, Instagram and anywhere else.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="store_slug" className="text-sm">Shop link</Label>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">{window.location.host}/shop/</span>
            <Input
              id="store_slug"
              value={slug}
              onChange={(e) => setSlug(toSlug(e.target.value))}
              placeholder="your-shop-name"
            />
            <Button
              type="button"
              onClick={handleSaveSlug}
              disabled={!slugValid || cleanSlug === savedSlug || isSavingSlug}
            >
              {isSavingSlug ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
          {!slugValid && slug && (
            <p className="text-xs text-destructive">3–40 letters, numbers and dashes.</p>
          )}
          {savedSlug && (
            <Link to={`/shop/${savedSlug}`} className="inline-flex items-center gap-1 text-xs text-primary">
              View your shop <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-sm">Cover banner</Label>
          <div className="relative h-28 overflow-hidden rounded-lg bg-gradient-to-br from-primary/25 via-primary/10 to-muted">
            {bannerUrl && <img src={bannerUrl} alt="Shop banner" className="h-full w-full object-cover" />}
          </div>
          <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={handleBanner} />
          <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={isUploading}>
            {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
            {bannerUrl ? "Change banner" : "Upload banner"}
          </Button>
          <p className="text-xs text-muted-foreground">Wide image works best (about 1500 × 500).</p>
        </div>
      </CardContent>
    </Card>
  );
}
