import { useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, RotateCcw, Smartphone, Users } from "lucide-react";
import { toast } from "sonner";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type ClientError = Database["public"]["Tables"]["client_errors"]["Row"];
type View = "open" | "fixed";

const ERRORS_KEY = ["admin-client-errors"] as const;
const ERRORS_LIMIT = 200;
const REFRESH_MS = 60_000;

/** "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 …) …" -> "iPhone · iOS 17.4" (rough, for a quick glance). */
function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ios = userAgent.match(/(iPhone|iPad).*OS (\d+)[_.](\d+)/);
  if (ios) return `${ios[1]} · iOS ${ios[2]}.${ios[3]}`;
  const android = userAgent.match(/Android (\d+(?:\.\d+)?)/);
  if (android) return `Android ${android[1]}`;
  if (/Windows/.test(userAgent)) return "Windows computer";
  if (/Macintosh/.test(userAgent)) return "Mac";
  return "Other device";
}

function pagePath(page: string | null): string {
  if (!page) return "Unknown page";
  try {
    return new URL(page).pathname;
  } catch {
    return page;
  }
}

function ErrorCard({ error }: { error: ClientError }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const fixed = !!error.resolved_at;
  const setResolved = useMutation({
    mutationFn: async (resolved: boolean) => {
      const { error: rpcError } = await supabase.rpc("admin_set_error_resolved", { p_error_id: error.id, p_resolved: resolved });
      if (rpcError) throw new Error(rpcError.message);
    },
    onSuccess: (_d, resolved) => {
      toast.success(resolved ? "Marked as fixed. You'll be alerted if it happens again." : "Reopened");
      queryClient.invalidateQueries({ queryKey: ERRORS_KEY });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update"),
  });

  return (
    <Card className={cn(!fixed && error.occurrences >= 10 && "border-destructive/50")}>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", fixed ? "text-muted-foreground" : "text-destructive")} />
          <p className="min-w-0 flex-1 break-words font-mono text-sm">{error.message}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">{error.occurrences}× </Badge>
          <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{error.affected_users} people</span>
          <span className="flex items-center gap-1"><Smartphone className="h-3.5 w-3.5" />{deviceLabel(error.user_agent)}</span>
          <span className="truncate">on {pagePath(error.page)}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Last seen {formatDistanceToNowStrict(new Date(error.last_seen_at), { addSuffix: true })} · first seen{" "}
          {formatDistanceToNowStrict(new Date(error.first_seen_at), { addSuffix: true })}
          {error.release ? ` · version ${error.release}` : ""}
        </p>
        {error.stack && (
          <div>
            <button type="button" onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1 text-xs font-medium text-primary">
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Hide details" : "Technical details"}
            </button>
            {expanded && (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed">{error.stack}</pre>
            )}
          </div>
        )}
        <div className="pt-1">
          {fixed ? (
            <Button size="sm" variant="outline" onClick={() => setResolved.mutate(false)} disabled={setResolved.isPending}>
              <RotateCcw className="mr-1.5 h-4 w-4" /> Reopen
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setResolved.mutate(true)} disabled={setResolved.isPending}>
              {setResolved.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
              Mark as fixed
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Admin: crashes and errors that happened on people's phones, grouped. */
export default function AdminErrors() {
  const [view, setView] = useState<View>("open");
  const { data = [], isLoading, isError, refetch } = useQuery({
    queryKey: ERRORS_KEY,
    queryFn: async (): Promise<ClientError[]> => {
      const { data: rows, error } = await supabase
        .from("client_errors")
        .select("*")
        .order("last_seen_at", { ascending: false })
        .limit(ERRORS_LIMIT);
      if (error) throw error;
      return (rows ?? []) as ClientError[];
    },
    refetchInterval: REFRESH_MS,
  });
  const open = data.filter((e) => !e.resolved_at);
  const fixed = data.filter((e) => e.resolved_at);
  const list = view === "open" ? open : fixed;

  return (
    <AdminLayout title="App errors">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When something breaks on a customer's or seller's phone, it shows up here and you get a notification. The same problem is grouped
          and counted, so you can see what affects the most people.
        </p>
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            <TabsTrigger value="open">Needs fixing ({open.length})</TabsTrigger>
            <TabsTrigger value="fixed">Fixed ({fixed.length})</TabsTrigger>
          </TabsList>
        </Tabs>
        {isLoading ? (
          <Skeleton className="h-32 w-full rounded-2xl" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            Could not load errors. <button className="underline" onClick={() => refetch()}>Try again</button>
          </p>
        ) : list.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{view === "open" ? "No errors. Everything is running smoothly." : "Nothing marked as fixed yet."}</p>
        ) : (
          <div className="space-y-3">
            {list.map((error) => (
              <ErrorCard key={error.id} error={error} />
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
