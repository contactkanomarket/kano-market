import { BellRing, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { usePushNotifications } from "@/hooks/usePushNotifications";

const DISMISS_KEY = "kk_push_prompt_dismissed_at";
const DISMISS_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function recentlyDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return !!at && Date.now() - at < DISMISS_DAYS * DAY_MS;
  } catch {
    return false;
  }
}

/** Soft ask on the home page; the browser's own prompt only appears after "Turn on". */
export function PushPrompt() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { status, busy, enable } = usePushNotifications();
  const [hidden, setHidden] = useState(recentlyDismissed);

  if (!user || hidden || status !== "off") return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // private mode: just hide for now
    }
    setHidden(true);
  };

  const handleEnable = async () => {
    try {
      await enable();
      toast.success(t("push.enabled"));
      setHidden(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("push.failed"));
    }
  };

  return (
    <div className="mx-4 mt-3 flex items-start gap-3 rounded-xl border bg-card p-3 shadow-sm">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
        <BellRing className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t("push.promptTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("push.promptBody")}</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" className="h-8" onClick={handleEnable} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            {t("push.turnOn")}
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={dismiss}>
            {t("push.notNow")}
          </Button>
        </div>
      </div>
      <button type="button" onClick={dismiss} aria-label={t("push.notNow")} className="text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
