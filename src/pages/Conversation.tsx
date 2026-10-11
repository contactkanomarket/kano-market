import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { format, isSameDay } from "date-fns";
import {
  ChevronDown,
  ChevronLeft,
  ImageOff,
  ImagePlus,
  Loader2,
  Mic,
  Phone,
  Send,
  Video,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { MobileLayout } from "@/components/layout/MobileLayout";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import {
  CHAT_AUDIO_TYPES,
  CHAT_IMAGE_TYPES,
  CHAT_MEDIA_MAX_BYTES,
  MEDIA_LABELS,
  baseMimeType,
  uploadChatMedia,
  useChatMediaUrl,
  useConversation,
  useTypingIndicator,
  type ChatMessage,
  type ConversationSummary,
  type MessageReaction,
} from "@/hooks/useChat";
import { ChatWithUsButton } from "@/components/chat/ChatWithUsButton";
import { ReactionChips, ReactionPicker } from "@/components/chat/MessageReactions";
import { VoicePlayer } from "@/components/chat/VoicePlayer";
import { LiveWaveform } from "@/components/chat/LiveWaveform";
import { useLongPress } from "@/hooks/useLongPress";
import { CreateOrderDialog } from "@/components/chat/CreateOrderDialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useCall } from "@/contexts/CallContext";
import { formatLastSeen, useConversationPresence } from "@/hooks/usePresence";

const MAX_RECORDING_SECONDS = 5 * 60;

/** Recorder formats in order of preference: webm/opus (Chrome, Firefox, Android), mp4/aac (Safari, iOS). */
const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return RECORDER_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

const formatDuration = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

/** One chat. With `admin`, it renders inside the admin dashboard. */
export default function Conversation({ admin = false }: { admin?: boolean }) {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const basePath = admin ? "/admin/messages" : "/messages";
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuth();
  const { conversation, messages, isLoading, sendMessage, userId, reactions, react } = useConversation(id);
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  const reactionsByMessage = new Map<string, MessageReaction[]>();
  for (const reaction of reactions) {
    const list = reactionsByMessage.get(reaction.message_id) ?? [];
    list.push(reaction);
    reactionsByMessage.set(reaction.message_id, list);
  }
  const setReaction = (messageId: string, emoji: string | null) => {
    setReactingTo(null);
    react.mutate({ messageId, emoji }, { onError: (e) => toast.error(e instanceof Error ? e.message : "Could not react") });
  };
  const { data: presence } = useConversationPresence(conversation?.id);
  const { startCall, inCall } = useCall();
  const presenceLabel = presence?.online ? "online" : presence?.lastSeenAt ? formatLastSeen(presence.lastSeenAt) : null;
  const { otherTyping, notifyTyping, notifyStopped } = useTypingIndicator(conversation?.id, userId);
  const [draft, setDraft] = useState("");
  const [orderOpen, setOrderOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Image attachment
  const [imagePreview, setImagePreview] = useState<{ file: File; url: string } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Voice recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [voiceNote, setVoiceNote] = useState<{ blob: Blob; url: string } | null>(null);
  const [recordStream, setRecordStream] = useState<MediaStream | null>(null);
  /** "Send" pressed while recording: send as soon as the recording is finalised. */
  const sendAfterStopRef = useRef(false);
  const [autoSendVoice, setAutoSendVoice] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardOnStopRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const showJumpRef = useRef(false);

  useEffect(() => {
    if (!authLoading && !user) navigate(`/auth?redirect=${basePath}/${id}`);
  }, [authLoading, user, navigate, id, basePath]);

  // Support chats opened from a notification or old link: answer them from the dashboard.
  useEffect(() => {
    if (!admin && conversation?.role === "support_team") navigate(`/admin/messages/${conversation.id}`, { replace: true });
  }, [admin, conversation?.role, conversation?.id, navigate]);

  // Follow new messages / the typing bubble unless the reader scrolled up.
  useEffect(() => {
    if (!showJumpRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, otherTyping]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 160;
    showJumpRef.current = away;
    setShowJump(away);
  };

  const jumpToLatest = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    showJumpRef.current = false;
    setShowJump(false);
  };

  // Object URLs are revoked when replaced and on unmount.
  useEffect(
    () => () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview.url);
    },
    [imagePreview],
  );
  useEffect(
    () => () => {
      if (voiceNote) URL.revokeObjectURL(voiceNote.url);
    },
    [voiceNote],
  );

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const releaseMic = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setRecordStream(null);
  };

  // Leaving the page mid-recording must release the microphone.
  useEffect(
    () => () => {
      discardOnStopRef.current = true;
      stopTimer();
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      releaseMic();
    },
    [],
  );

  const failSend = (error: unknown) => {
    toast.error(error instanceof Error && error.message ? error.message : t("chat.sendFailed"));
  };

  // ── Images ───────────────────────────────────────────────────────
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(baseMimeType(file.type))) {
      toast.error(t("chat.unsupportedImage"));
      return;
    }
    if (file.size > CHAT_MEDIA_MAX_BYTES) {
      toast.error(t("chat.fileTooLarge"));
      return;
    }
    setImagePreview({ file, url: URL.createObjectURL(file) });
  };

  const sendImage = async () => {
    if (!imagePreview || !conversation) return;
    setUploading(true);
    try {
      const mediaPath = await uploadChatMedia(conversation.id, imagePreview.file);
      await sendMessage.mutateAsync({
        body: draft.trim() || MEDIA_LABELS.image,
        messageType: "image",
        mediaPath,
      });
      setImagePreview(null);
      setDraft("");
      notifyStopped();
    } catch (error: unknown) {
      failSend(error);
    } finally {
      setUploading(false);
    }
  };

  const handleSend = async () => {
    if (imagePreview) return sendImage();
    const body = draft.trim();
    if (!body) return;
    try {
      await sendMessage.mutateAsync({ body, messageType: "text" });
      setDraft("");
      notifyStopped();
    } catch (error: unknown) {
      failSend(error);
    }
  };

  // ── Voice notes ──────────────────────────────────────────────────
  const startRecording = async () => {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t("chat.recordingUnsupported"));
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error(t("chat.micDenied"));
      return;
    }
    try {
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      discardOnStopRef.current = false;
      streamRef.current = stream;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        releaseMic();
        recorderRef.current = null;
        if (discardOnStopRef.current) {
          chunksRef.current = [];
          return;
        }
        // Strip codec params ("audio/webm;codecs=opus" -> "audio/webm") so storage accepts the type.
        const type = baseMimeType(recorder.mimeType || mimeType || "audio/webm");
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) return;
        setVoiceNote({ blob, url: URL.createObjectURL(blob) });
        if (sendAfterStopRef.current) {
          sendAfterStopRef.current = false;
          setAutoSendVoice(true);
        }
      };

      recorder.start(250);
      recorderRef.current = recorder;
      setRecordStream(stream);
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime((s) => s + 1), 1000);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      toast.error(t("chat.recordingUnsupported"));
    }
  };

  const stopRecording = useCallback((discard: boolean, sendNow = false) => {
    discardOnStopRef.current = discard;
    sendAfterStopRef.current = !discard && sendNow;
    stopTimer();
    setIsRecording(false);
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    else releaseMic();
  }, []);

  // Cap recordings so files stay well under the 10 MB limit.
  useEffect(() => {
    if (isRecording && recordingTime >= MAX_RECORDING_SECONDS) stopRecording(false);
  }, [isRecording, recordingTime, stopRecording]);

  const discardVoiceNote = () => {
    setVoiceNote(null);
    setRecordingTime(0);
  };

  const sendVoiceNote = async () => {
    if (!voiceNote || !conversation) return;
    if (!(CHAT_AUDIO_TYPES as readonly string[]).includes(baseMimeType(voiceNote.blob.type))) {
      toast.error(t("chat.recordingUnsupported"));
      return;
    }
    setUploading(true);
    try {
      const mediaPath = await uploadChatMedia(conversation.id, voiceNote.blob);
      await sendMessage.mutateAsync({ body: MEDIA_LABELS.voice, messageType: "voice", mediaPath });
      discardVoiceNote();
    } catch (error: unknown) {
      failSend(error);
    } finally {
      setUploading(false);
    }
  };

  // "Send" tapped while recording: send once the recorder has produced the file.
  useEffect(() => {
    if (autoSendVoice && voiceNote) {
      setAutoSendVoice(false);
      sendVoiceNote();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendVoiceNote is recreated each render
  }, [autoSendVoice, voiceNote]);

  const otherLink = conversation?.role === "customer" && conversation.shop_slug ? `/shop/${conversation.shop_slug}` : null;
  const busy = uploading || sendMessage.isPending;
  const canRecord = !draft.trim() && !imagePreview;

  const chat = (
    <>
      <div
        className={cn(
          "relative flex flex-col overflow-hidden",
          // Soft warm backdrop that shows through the glass header and composer.
          "bg-[radial-gradient(120%_60%_at_100%_0%,hsl(var(--primary)/0.10),transparent_60%),radial-gradient(90%_50%_at_0%_100%,rgba(212,160,23,0.10),transparent_60%)] bg-background",
          // In the dashboard: fit between the admin header/title and the bottom bar.
          admin ? "h-[calc(100dvh-11.5rem)] rounded-xl border md:h-[calc(100dvh-7.5rem)]" : "h-[100dvh]",
        )}
      >
        {/* Header */}
        <div
          className={cn(
            "absolute inset-x-0 top-0 z-30 flex items-center gap-2.5 border-b border-white/30 bg-background/65 px-2 py-2 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.25)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10",
            !admin && "pt-[calc(env(safe-area-inset-top)+0.5rem)]",
          )}
        >
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 rounded-full" onClick={() => navigate(basePath)} aria-label={t("chat.backToMessages")}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          {conversation ? (
            <>
              <div className="relative shrink-0">
                <Avatar className="h-10 w-10 ring-2 ring-white/70 shadow-sm dark:ring-white/10">
                  <AvatarImage src={conversation.other_party_avatar || undefined} alt="" />
                  <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary text-primary-foreground">{conversation.other_party_name.charAt(0)}</AvatarFallback>
                </Avatar>
                {presence?.online && (
                  <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-background bg-green-500" aria-label="Online" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                {otherLink ? (
                  <Link to={otherLink} className="block truncate text-[15px] font-semibold leading-tight hover:underline">
                    {conversation.other_party_name}
                  </Link>
                ) : (
                  <p className="truncate text-[15px] font-semibold leading-tight">{conversation.other_party_name}</p>
                )}
                {otherTyping ? (
                  <p className="truncate text-xs font-medium text-green-600">{t("chat.typing")}</p>
                ) : presenceLabel ? (
                  <p className={cn("truncate text-xs", presence?.online ? "font-medium text-green-600" : "text-muted-foreground")}>
                    {presenceLabel}
                  </p>
                ) : (
                  conversation.product_name &&
                  conversation.product_slug && (
                    <Link
                      to={`/products/${conversation.product_slug}`}
                      className="block truncate text-xs text-muted-foreground hover:underline"
                    >
                      {t("chat.about")}: {conversation.product_name}
                    </Link>
                  )
                )}
              </div>
            </>
          ) : (
            <Skeleton className="h-10 flex-1 rounded-full" />
          )}
          {conversation && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full border border-white/40 bg-white/40 shadow-sm backdrop-blur hover:bg-white/70 dark:border-white/10 dark:bg-white/5"
              aria-label={`Voice call ${conversation.other_party_name}`}
              disabled={inCall}
              onClick={() => startCall(conversation.id, { name: conversation.other_party_name, avatar: conversation.other_party_avatar })}
            >
              <Phone className="h-5 w-5" />
            </Button>
          )}
          {conversation && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full border border-white/40 bg-white/40 shadow-sm backdrop-blur hover:bg-white/70 dark:border-white/10 dark:bg-white/5"
              aria-label={`Video call ${conversation.other_party_name}`}
              disabled={inCall}
              onClick={() => startCall(conversation.id, { name: conversation.other_party_name, avatar: conversation.other_party_avatar }, "video")}
            >
              <Video className="h-5 w-5" />
            </Button>
          )}
          {conversation?.role === "support_team" && conversation.other_party_id && (
            <Button size="sm" className="shrink-0 rounded-full" onClick={() => setOrderOpen(true)}>
              <ShoppingBag className="mr-1 h-4 w-4" />
              {t("chat.createOrder")}
            </Button>
          )}
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          data-no-pull-refresh
          className={cn(
            "flex-1 space-y-1.5 overflow-y-auto px-3",
            admin ? "pt-20" : "pt-[calc(env(safe-area-inset-top)+5rem)]",
            imagePreview ? "pb-48" : "pb-28",
          )}
        >
          <ChatNotice conversation={conversation} />

          {isLoading ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin" />
          ) : !conversation ? (
            <p className="text-center text-sm text-muted-foreground">{t("chat.notFound")}</p>
          ) : messages.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">{t("chat.sayHello")}</p>
          ) : (
            messages.map((message, index) => {
              const mine = message.sender_id === userId;
              const created = new Date(message.created_at);
              const showDate = index === 0 || !isSameDay(created, new Date(messages[index - 1].created_at));
              return (
                <div key={message.id} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
                  {showDate && (
                    <p className="my-3 flex justify-center">
                      <span className="rounded-full border border-white/40 bg-background/70 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur dark:border-white/10">
                        {format(created, "EEE, MMM d")}
                      </span>
                    </p>
                  )}
                  <ReactableMessage
                    message={message}
                    mine={mine}
                    userId={userId}
                    reactions={reactionsByMessage.get(message.id) ?? []}
                    pickerOpen={reactingTo === message.id}
                    onOpenPicker={() => setReactingTo(message.id)}
                    onClosePicker={() => setReactingTo(null)}
                    onReact={(emoji) => setReaction(message.id, emoji)}
                    onOpenImage={setLightboxSrc}
                  />
                </div>
              );
            })
          )}

          {otherTyping && (
            <div className="flex justify-start animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
              <div className="rounded-3xl rounded-bl-md border border-white/50 bg-background/80 shadow-sm backdrop-blur dark:border-white/10" role="status" aria-label={t("chat.typing")}>
                <TypingDots />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {showJump && (
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label={t("chat.jumpToLatest")}
            className="absolute bottom-28 right-4 z-20 rounded-full border border-white/40 bg-background/80 p-2 text-foreground shadow-lg backdrop-blur-xl transition-colors animate-in zoom-in-75 duration-200 hover:bg-background dark:border-white/10"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        )}

        {conversation?.role === "support_team" && conversation.other_party_id && (
          <CreateOrderDialog
            open={orderOpen}
            onOpenChange={setOrderOpen}
            customerId={conversation.other_party_id}
            conversationId={conversation.id}
            suggestedProductId={conversation.product_id}
          />
        )}

        {/* Composer */}
        {conversation && (
          <div className="absolute inset-x-0 bottom-0 z-30 px-2.5 pb-[max(0.6rem,env(safe-area-inset-bottom))] pt-2">
            {/* Image preview (the text box below becomes its caption) */}
            {imagePreview && (
              <div className="mb-2 flex items-center gap-2 rounded-3xl border border-white/40 bg-background/75 p-2 shadow-lg backdrop-blur-2xl animate-in slide-in-from-bottom-2 duration-200 dark:border-white/10">
                <img src={imagePreview.url} alt="" className="h-14 w-14 flex-shrink-0 rounded-2xl object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{imagePreview.file.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {(imagePreview.file.size / 1024).toFixed(0)} KB · {t("chat.captionHint")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setImagePreview(null)}
                  disabled={uploading}
                  aria-label={t("chat.removeImage")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}

            {isRecording ? (
              /* Recording in progress: live waveform, timer, cancel / stop / send */
              <div className="flex items-center gap-2 rounded-full border border-white/40 bg-background/75 p-1.5 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.35)] backdrop-blur-2xl animate-in fade-in-0 slide-in-from-bottom-2 duration-200 dark:border-white/10">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-10 w-10 shrink-0 rounded-full text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                  onClick={() => stopRecording(true)}
                  aria-label={t("chat.cancelRecording")}
                  title={t("chat.cancelRecording")}
                >
                  <Trash2 className="h-5 w-5" />
                </Button>
                <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold tabular-nums text-red-600">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.2)]" />
                  {formatDuration(recordingTime)}
                </span>
                <LiveWaveform stream={recordStream} className="min-w-0 flex-1 px-1" />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-10 w-10 shrink-0 rounded-full"
                  onClick={() => stopRecording(false)}
                  aria-label={`${t("chat.stop")} (listen before sending)`}
                  title={t("chat.stop")}
                >
                  <Square className="h-4 w-4 fill-current" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  className="h-11 w-11 shrink-0 rounded-full bg-gradient-to-br from-primary to-primary/80 shadow-md"
                  onClick={() => stopRecording(false, true)}
                  aria-label={t("chat.send")}
                >
                  <Send className="h-5 w-5" />
                </Button>
              </div>
            ) : voiceNote ? (
              /* Recorded, ready to listen and send */
              <div className="flex items-center gap-2 rounded-full border border-white/40 bg-background/75 p-1.5 pl-3 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.35)] backdrop-blur-2xl animate-in slide-in-from-bottom-2 duration-200 dark:border-white/10">
                <VoicePlayer src={voiceNote.url} className="min-w-0 flex-1" />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-10 w-10 shrink-0 rounded-full text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                  onClick={discardVoiceNote}
                  disabled={uploading}
                  aria-label={t("chat.discardVoice")}
                  title={t("chat.discardVoice")}
                >
                  <Trash2 className="h-5 w-5" />
                </Button>
                <Button
                  size="icon"
                  className="h-11 w-11 shrink-0 rounded-full bg-gradient-to-br from-primary to-primary/80 shadow-md"
                  onClick={sendVoiceNote}
                  disabled={busy}
                  aria-label={t("chat.send")}
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                </Button>
              </div>
            ) : (
              /* Text / image composer: floating glass pill */
              <div className="flex items-end gap-2">
                <div className="flex min-w-0 flex-1 items-end gap-1 rounded-[26px] border border-white/40 bg-background/75 p-1 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.35)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10">
                <input
                  ref={imageInputRef}
                  type="file"
                  accept={CHAT_IMAGE_TYPES.join(",")}
                  className="hidden"
                  onChange={handleImageSelect}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 shrink-0 rounded-full"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={busy}
                  aria-label={t("chat.sendImage")}
                  title={t("chat.sendImage")}
                >
                  <ImagePlus className="h-5 w-5 text-muted-foreground" />
                </Button>
                <Textarea
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (e.target.value.trim()) notifyTyping();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={imagePreview ? t("chat.addCaption") : t("chat.placeholder")}
                  rows={1}
                  maxLength={2000}
                  className="max-h-32 min-h-[40px] resize-none border-0 bg-transparent px-1 py-2.5 text-[15px] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                />
                </div>
                {canRecord ? (
                  <Button
                    type="button"
                    size="icon"
                    className="h-12 w-12 shrink-0 rounded-full bg-gradient-to-br from-primary to-primary/80 shadow-lg transition-transform active:scale-90"
                    onClick={startRecording}
                    disabled={busy}
                    aria-label={t("chat.recordVoice")}
                    title={t("chat.recordVoice")}
                  >
                    <Mic className="h-5 w-5" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    className="h-12 w-12 shrink-0 rounded-full bg-gradient-to-br from-primary to-primary/80 shadow-lg transition-transform animate-in zoom-in-75 duration-150 active:scale-90"
                    onClick={handleSend}
                    disabled={busy || (!draft.trim() && !imagePreview)}
                    aria-label={t("chat.send")}
                  >
                    {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 animate-in fade-in-0 duration-200"
          onClick={() => setLightboxSrc(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full bg-white/20 p-2 transition-colors hover:bg-white/30"
            onClick={() => setLightboxSrc(null)}
            aria-label={t("chat.close")}
          >
            <X className="h-5 w-5 text-white" />
          </button>
          <img
            src={lightboxSrc}
            alt=""
            className="max-h-full max-w-full rounded-xl object-contain animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );

  return admin ? (
    <AdminLayout title="Messages">{chat}</AdminLayout>
  ) : (
    <MobileLayout hideHeader hideBottomNav>{chat}</MobileLayout>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-4 py-3">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-typing-dot"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </div>
  );
}

/** A message with long-press reactions and the reaction chips under it. */
function ReactableMessage({
  message,
  mine,
  userId,
  reactions,
  pickerOpen,
  onOpenPicker,
  onClosePicker,
  onReact,
  onOpenImage,
}: {
  message: ChatMessage;
  mine: boolean;
  userId: string | null;
  reactions: MessageReaction[];
  pickerOpen: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onReact: (emoji: string | null) => void;
  onOpenImage: (src: string) => void;
}) {
  const longPress = useLongPress(onOpenPicker);
  const myReaction = reactions.find((r) => r.user_id === userId)?.emoji ?? null;
  const copyable = message.message_type === "text";

  const copy = async () => {
    onClosePicker();
    try {
      await navigator.clipboard.writeText(message.body);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  };

  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start", reactions.length > 0 && "mb-1")}>
      <div
        {...longPress}
        className={cn(
          "relative flex max-w-[80%] select-none [-webkit-touch-callout:none]",
          mine ? "justify-end" : "justify-start",
          pickerOpen && "z-50",
        )}
      >
        {pickerOpen && (
          <ReactionPicker
            mine={mine}
            current={myReaction}
            onPick={onReact}
            onCopy={copyable ? copy : undefined}
            onClose={onClosePicker}
          />
        )}
        <div className={cn("relative transition-transform", pickerOpen && "z-50 scale-[1.02]")}>
          <MessageBubble message={message} mine={mine} onOpenImage={onOpenImage} />
        </div>
      </div>
      <ReactionChips
        reactions={reactions}
        userId={userId}
        mine={mine}
        onToggle={(emoji) => onReact(emoji === myReaction ? null : emoji)}
      />
    </div>
  );
}

function MessageBubble({
  message,
  mine,
  onOpenImage,
}: {
  message: ChatMessage;
  mine: boolean;
  onOpenImage: (src: string) => void;
}) {
  const created = new Date(message.created_at);
  const isImage = message.message_type === "image" && !!message.media_path;
  const isVoice = message.message_type === "voice" && !!message.media_path;
  // Media messages carry a default label body; any other body on an image is its caption.
  const caption = isImage && message.body !== MEDIA_LABELS.image ? message.body : null;

  return (
    <div
      className={cn(
        "max-w-full whitespace-pre-wrap break-words rounded-3xl text-[15px] leading-snug",
        isImage ? "overflow-hidden p-1" : isVoice ? "px-2.5 py-2" : "px-3.5 py-2",
        mine
          ? "rounded-br-md bg-gradient-to-br from-primary to-primary/85 text-primary-foreground shadow-[0_6px_20px_-8px_hsl(var(--primary)/0.6)]"
          : "rounded-bl-md border border-white/50 bg-background/80 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.2)] backdrop-blur dark:border-white/10",
      )}
    >
      {isImage ? (
        <ImageAttachment path={message.media_path!} onOpen={onOpenImage} />
      ) : isVoice ? (
        <VoiceAttachment path={message.media_path!} mine={mine} />
      ) : (
        <MessageBody body={message.body} mine={mine} />
      )}
      {caption && (
        <p className="px-2 pt-1">
          <MessageBody body={caption} mine={mine} />
        </p>
      )}
      <span
        className={cn(
          "mt-1 block text-right text-[10px]",
          isImage && "px-2 pb-0.5",
          mine ? "text-primary-foreground/70" : "text-muted-foreground",
        )}
      >
        {format(created, "h:mm a")}
      </span>
    </div>
  );
}

function ImageAttachment({ path, onOpen }: { path: string; onOpen: (src: string) => void }) {
  const { t } = useTranslation();
  const { data: src, isLoading, isError } = useChatMediaUrl(path);
  const [failed, setFailed] = useState(false);

  if (isLoading) return <Skeleton className="h-[180px] w-[220px] max-w-full rounded-xl" />;
  if (isError || failed || !src) {
    return (
      <div className="flex h-24 w-[220px] max-w-full flex-col items-center justify-center gap-1 rounded-xl bg-background/30 text-xs opacity-80">
        <ImageOff className="h-5 w-5" />
        {t("chat.mediaUnavailable")}
      </div>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(src)} className="block" aria-label={t("chat.viewImage")}>
      <img
        src={src}
        alt={t("chat.image")}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-[260px] w-[220px] max-w-full cursor-zoom-in rounded-xl object-cover transition-opacity hover:opacity-90"
      />
    </button>
  );
}

function VoiceAttachment({ path, mine }: { path: string; mine: boolean }) {
  const { t } = useTranslation();
  const { data: src, isLoading, isError } = useChatMediaUrl(path);

  if (isLoading) return <Skeleton className="h-11 w-[230px] max-w-full rounded-full" />;
  if (isError || !src) {
    return (
      <span className="flex items-center gap-2 py-1 text-xs opacity-80">
        <Mic className="h-4 w-4" /> {t("chat.mediaUnavailable")}
      </span>
    );
  }
  return <VoicePlayer src={src} tone={mine ? "dark" : "light"} />;
}

/** Context banner at the top of a thread. */
function ChatNotice({ conversation }: { conversation: ConversationSummary | null }) {
  const { t } = useTranslation();
  if (!conversation) return null;

  if (conversation.role === "support_user") {
    return (
      <div className="mx-auto mb-3 flex max-w-md gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 flex-shrink-0 text-primary" />
        <p>
          You're chatting with the Kano Kaftan team. Tell us what you'd like to buy: we get it from the seller, arrange
          delivery and send you a secure payment link here. The seller is only fully paid after you receive it.
        </p>
      </div>
    );
  }

  if (conversation.role === "support_team") {
    return (
      <div className="mx-auto mb-3 flex max-w-md gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 flex-shrink-0 text-primary" />
        <p>
          Support chat with {conversation.other_party_is_vendor ? "a vendor" : "a customer"}. Replies are sent as Kano
          Kaftan and every admin can see this thread.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mb-3 max-w-md space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <div className="flex gap-2">
        <ShieldAlert className="h-4 w-4 flex-shrink-0" />
        <p>
          {conversation.role === "customer"
            ? "Deals you agree directly with the seller, and payments made outside Kano Kaftan, are at your own risk."
            : "Deals agreed directly with customers are outside Kano Kaftan's protection."}
        </p>
      </div>
      {conversation.role === "customer" && (
        <ChatWithUsButton
          size="sm"
          variant="outline"
          className="w-full bg-background"
          productId={conversation.product_id ?? undefined}
          label={t("chat.buyProtected")}
        />
      )}
    </div>
  );
}

/** Turns "/orders/<id>" in a message into a tappable link. */
function MessageBody({ body, mine }: { body: string; mine: boolean }) {
  const { t } = useTranslation();
  const parts = body.split(/(\/orders\/[0-9a-f-]{36})/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\/orders\/[0-9a-f-]{36}$/.test(part) ? (
          <Link key={i} to={part} className={cn("font-semibold underline", mine ? "text-primary-foreground" : "text-primary")}>
            {t("chat.openOrder")}
          </Link>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
