import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Store, Loader2, ChevronLeft, BadgeCheck, ShieldCheck, Wallet, Megaphone } from "lucide-react";
import { MobileLayout } from "@/components/layout/MobileLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { NIGERIAN_STATES } from "@/lib/nigeria";
import { toast } from "sonner";

const PHONE_PATTERN = /^(\+?234|0)[789][01]\d{8}$/;

function formatNaira(amount: number): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 0 }).format(amount);
}

/** Opening a shop: free, takes a minute; verification and promotion are optional extras later. */
export default function BecomeVendor() {
  const navigate = useNavigate();
  const { user, isLoading: authLoading, isVendor, rolesLoading, refreshRoles } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [form, setForm] = useState({
    store_name: "",
    phone: "",
    city: "",
    state: "Kano",
    store_description: "",
  });

  const { data: settings } = useQuery({
    queryKey: ["platform-settings", "become-vendor"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_settings")
        .select("commission_percent, verification_fee")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth?mode=register&redirect=/become-vendor");
  }, [authLoading, user, navigate]);

  if (!authLoading && !rolesLoading && isVendor) {
    return (
      <MobileLayout>
        <div className="px-4 py-6 pb-24">
          <Card className="border-primary">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <BadgeCheck className="mb-4 h-16 w-16 text-primary" />
              <h1 className="mb-2 font-display text-xl font-bold">You already have a shop</h1>
              <p className="mb-6 text-muted-foreground">Manage your products, orders and payouts from your seller dashboard.</p>
              <Button onClick={() => navigate("/vendor/dashboard")}>Go to seller dashboard</Button>
            </CardContent>
          </Card>
        </div>
      </MobileLayout>
    );
  }

  const update = (field: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const phone = form.phone.replace(/[\s-]/g, "");

    if (form.store_name.trim().length < 2) return toast.error("Enter your shop name");
    if (!PHONE_PATTERN.test(phone)) return toast.error("Enter a valid Nigerian phone number, e.g. 0803 123 4567");
    if (form.city.trim().length < 2) return toast.error("Enter the town or city where you work");
    if (form.store_description.trim().length < 20) return toast.error("Tell customers a little more about what you sell (at least 20 characters)");
    if (!agreed) return toast.error("Please accept the seller terms to continue");

    setIsSubmitting(true);
    try {
      const { error } = await supabase.rpc("become_vendor", {
        p_store_name: form.store_name.trim(),
        p_store_description: form.store_description.trim(),
        p_phone: phone,
      });
      if (error) throw new Error(error.message);

      // Location helps delivery estimates and the shop page; the shop is open even if this fails.
      if (user) {
        const { error: addressError } = await supabase
          .from("profiles")
          .update({ store_address: { city: form.city.trim(), state: form.state } })
          .eq("id", user.id);
        if (addressError) console.error("Saving shop location failed:", addressError);
      }

      await refreshRoles();
      toast.success("Your shop is open!", { description: "Finish the checklist on your dashboard to start selling." });
      navigate("/vendor/dashboard");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not open your shop";
      console.error("become_vendor failed:", error);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const commission = settings?.commission_percent ?? 10;
  const verificationFee = settings?.verification_fee;

  return (
    <MobileLayout>
      <div className="px-4 py-6 pb-24">
        <div className="mb-6 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back">
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-display text-xl font-bold">Sell on Kano Kaftan</h1>
            <p className="text-sm text-muted-foreground">Open your shop free in a minute</p>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">How selling works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex gap-3">
              <Store className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
              <p><strong>Free to open.</strong> List your products and get your own shop page and link.</p>
            </div>
            <div className="flex gap-3">
              <Wallet className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
              <p>
                <strong>Safe payments.</strong> Customers pay Kano Kaftan. You receive half when the order is paid and the rest
                once it is delivered, minus a {commission}% commission, straight to your bank account.
              </p>
            </div>
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
              <p>
                <strong>Get verified (optional).</strong> {verificationFee ? `For a one-time ${formatNaira(verificationFee)}, ` : ""}
                we check your ID and business, and you get a verified badge that buyers trust.
              </p>
            </div>
            <div className="flex gap-3">
              <Megaphone className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
              <p><strong>Promote (verified shops).</strong> Feature your products or shop logo on the homepage by the week.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your shop</CardTitle>
            <CardDescription>You can change these later in your shop settings.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="store_name">Shop name *</Label>
                <Input
                  id="store_name"
                  placeholder="e.g. Alhaji Musa Tailoring"
                  value={form.store_name}
                  onChange={(e) => update("store_name")(e.target.value)}
                  maxLength={60}
                  autoComplete="organization"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Phone / WhatsApp *</Label>
                <Input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  placeholder="0803 123 4567"
                  value={form.phone}
                  onChange={(e) => update("phone")(e.target.value)}
                  autoComplete="tel"
                />
                <p className="text-xs text-muted-foreground">We use this to arrange pickups. Customers don't see it.</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="city">Town / city *</Label>
                  <Input id="city" placeholder="e.g. Kano" value={form.city} onChange={(e) => update("city")(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State *</Label>
                  <Select value={form.state} onValueChange={update("state")}>
                    <SelectTrigger id="state">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NIGERIAN_STATES.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="store_description">What do you sell? *</Label>
                <Textarea
                  id="store_description"
                  placeholder="e.g. Hand-embroidered babban riga and kaftans, made to measure in Kano since 2010."
                  value={form.store_description}
                  onChange={(e) => update("store_description")(e.target.value)}
                  rows={4}
                  maxLength={600}
                />
              </div>

              <div className="flex items-start gap-3 rounded-lg border p-3">
                <Checkbox id="agree" checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} className="mt-0.5" />
                <Label htmlFor="agree" className="text-sm font-normal leading-snug">
                  I will only sell items I have, describe them honestly and ship on time. I agree to the{" "}
                  <Link to="/terms" target="_blank" className="text-primary underline">Terms of Service</Link>, including the seller rules.
                </Label>
              </div>

              <Button type="submit" className="w-full" disabled={isSubmitting || authLoading}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Open my shop
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </MobileLayout>
  );
}
