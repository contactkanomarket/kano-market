import { Link } from "react-router-dom";
import { format, isToday, isYesterday } from "date-fns";
import { PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Phone, Video } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCall } from "@/contexts/CallContext";
import { formatCallDuration, isMissedForMe, useCallHistory, type CallHistoryItem } from "@/hooks/useCallHistory";
import { cn } from "@/lib/utils";

function when(date: string): string {
  const d = new Date(date);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return `Yesterday ${format(d, "HH:mm")}`;
  return format(d, "d MMM, HH:mm");
}

function describe(call: CallHistoryItem): string {
  const type = call.kind === "video" ? "Video" : "Voice";
  if (call.duration_seconds != null && (call.status === "ended" || call.status === "failed")) {
    return `${call.outgoing ? "Outgoing" : "Incoming"} ${type.toLowerCase()} · ${formatCallDuration(call.duration_seconds)}`;
  }
  switch (call.status) {
    case "declined": return call.outgoing ? `${type} call declined` : `You declined a ${type.toLowerCase()} call`;
    case "missed":
    case "cancelled": return call.outgoing ? `No answer (${type.toLowerCase()})` : `Missed ${type.toLowerCase()} call`;
    default: return `${type} call`;
  }
}

function DirectionIcon({ call }: { call: CallHistoryItem }) {
  const missed = isMissedForMe(call);
  const Icon = missed ? PhoneMissed : call.outgoing ? PhoneOutgoing : PhoneIncoming;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", missed ? "text-red-500" : "text-muted-foreground")} />;
}

/** Recent calls: tap a row to open the chat, or the phone/camera button to call back. */
export function CallHistory({ basePath }: { basePath: string }) {
  const { data: calls = [], isLoading, error } = useCallHistory();
  const { startCall, inCall } = useCall();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
      </div>
    );
  }
  if (error) return <p className="py-8 text-center text-sm text-destructive">Could not load your calls. Pull down to try again.</p>;
  if (calls.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-center text-muted-foreground">
        <PhoneCall className="mb-3 h-12 w-12 opacity-50" />
        <p>No calls yet.</p>
        <p className="text-sm">Open a chat and tap the phone or camera button to call.</p>
      </div>
    );
  }

  return (
    // WhatsApp-style list: no box, a thin line under each row starting after the picture.
    <ul className={cn(!basePath.startsWith("/admin") && "-mx-4")}>
      {calls.map((call) => {
        const missed = isMissedForMe(call);
        return (
          <li key={call.id} className="group flex items-center gap-3 pl-4 transition-colors active:bg-muted/70 hover:bg-muted/40">
            <Avatar className="h-12 w-12 shrink-0">
                <AvatarImage src={call.other_party_avatar || undefined} alt="" />
                <AvatarFallback>{call.other_party_name.charAt(0)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 items-center gap-2 border-b border-border/60 py-3 pr-2 group-last:border-b-0">
            <Link to={`${basePath}/${call.conversation_id}`} className="flex min-w-0 flex-1 items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-[15px] font-medium", missed && "text-red-600")}>{call.other_party_name}</p>
                <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                  <DirectionIcon call={call} />
                  <span className="truncate">{describe(call)}</span>
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{when(call.created_at)}</span>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              disabled={inCall}
              aria-label={`Call ${call.other_party_name} back`}
              onClick={() => startCall(call.conversation_id, { name: call.other_party_name, avatar: call.other_party_avatar }, call.kind === "video" ? "video" : "voice")}
            >
              {call.kind === "video" ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
            </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
