import { useEffect, useState } from "react";
import { Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePlatformSettings } from "@/hooks/usePayouts";
import { toast } from "sonner";

export function PayoutSettingsCard() {
  const { settings, updateSettings } = usePlatformSettings();
  const [commission, setCommission] = useState("");
  const [releaseDays, setReleaseDays] = useState("");

  useEffect(() => {
    if (settings) {
      setCommission(String(settings.commission_percent));
      setReleaseDays(String(settings.auto_release_days));
    }
  }, [settings]);

  const commissionValue = Number(commission);
  const daysValue = Number(releaseDays);
  const valid =
    commission !== "" && commissionValue >= 0 && commissionValue <= 100 &&
    Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= 60;

  const handleSave = async () => {
    try {
      await updateSettings.mutateAsync({ commission_percent: commissionValue, auto_release_days: daysValue });
      toast.success("Payout settings saved. They apply to new orders.");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not save settings");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Percent className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">Commission & payouts</CardTitle>
        </div>
        <CardDescription>
          Your cut of each sale, and how long after shipping the vendor's second half is released if the
          customer doesn't confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="commission">Commission (%)</Label>
            <Input id="commission" type="number" min={0} max={100} step="0.5" value={commission} onChange={(e) => setCommission(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="release-days">Auto-release (days)</Label>
            <Input id="release-days" type="number" min={1} max={60} value={releaseDays} onChange={(e) => setReleaseDays(e.target.value)} />
          </div>
        </div>
        <Button onClick={handleSave} disabled={!valid || updateSettings.isPending}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
