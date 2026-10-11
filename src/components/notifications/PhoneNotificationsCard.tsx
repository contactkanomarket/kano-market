import { useState } from "react";
import { BellRing, Loader2, Share } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { usePushNotifications } from "@/hooks/usePushNotifications";

/** Turn lock-screen notifications on/off for this phone, with help when the phone can't yet. */
export function PhoneNotificationsCard({ onEnabled }: { onEnabled?: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { status, busy, enable, disable, sendTest } = usePushNotifications();
  const [testing, setTesting] = useState(false);

  const handleEnable = async () => {
    try {
      await enable();
      toast.success(t("push.enabled"));
      onEnabled?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("push.failed"));
    }
  };

  const handleDisable = async () => {
    await disable();
    toast.success(t("push.disabled"));
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await sendTest();
      toast.success(t("push.testSent"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("push.failed"));
    } finally {
      setTesting(false);
    }
  };

  const help =
    status === "needs-install" ? t("push.needsInstall")
    : status === "blocked" ? t("push.blocked")
    : status === "unsupported" ? t("push.unsupported")
    : !user ? t("push.signInFirst")
    : null;

  return (
    <div className="space-y-3 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
            <BellRing className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("push.title")}</p>
            <p className="truncate text-xs text-muted-foreground">{status === "on" ? t("push.descOn") : t("push.descOff")}</p>
          </div>
        </div>
        {status === "loading" ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : status === "on" ? (
          <Button variant="outline" size="sm" onClick={handleDisable} disabled={busy}>
            {t("push.turnOff")}
          </Button>
        ) : status === "off" && user ? (
          <Button size="sm" onClick={handleEnable} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {t("push.turnOn")}
          </Button>
        ) : null}
      </div>

      {help && (
        <p className="flex gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          {status === "needs-install" && <Share className="h-4 w-4 flex-shrink-0" />}
          {help}
        </p>
      )}

      {status === "on" && (
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={handleTest} disabled={testing}>
          {testing && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
          {t("push.sendTest")}
        </Button>
      )}
    </div>
  );
}
