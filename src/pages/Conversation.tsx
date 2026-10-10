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
  Send,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { MobileLayout } from "@/components/layout/MobileLayout";
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
} from "@/hooks/useChat";
import { ChatWithUsButton } from "@/components/chat/ChatWithUsButton";
import { CreateOrderDialog } from "@/components/chat/CreateOrderDialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const MAX_RECORDING_SECONDS = 5 * 60;

/** Recorder formats in order of preference: webm/opus (Chrome, Firefox, Android), mp4/aac (Safari, iOS). */
const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return RECORDER_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

const formatDuration = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

export default function Conversation() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuth();
  const { conversation, messages, isLoading, sendMessage, userId } = useConversation(id);
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardOnStopRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const showJumpRef = useRef(false);

  useEffect(() => {
    if (!authLoading && !user) navigate(`/auth?redirect=/messages/${id}`);
  }, [authLoading, user, navigate, id]);

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
      };

      recorder.start(250);
      recorderRef.current = recorder;
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime((s) => s + 1), 1000);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      toast.error(t("chat.recordingUnsupported"));
    }
  };

  const stopRecording = useCallback((discard: boolean) => {
    discardOnStopRef.current = discard;
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

  const otherLink = conversation?.role === "customer" && conversation.shop_slug ? `/shop/${conversation.shop_slug}` : null;
  const busy = uploading || sendMessage.isPending;
  const canRecord = !draft.trim() && !imagePreview;

  return (
    <MobileLayout hideHeader hideBottomNav>
      <div className="relative flex h-[100dvh] flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 border-b bg-background px-3 py-2">
          <Button variant="ghost" size="icon" onClick={() => navigate("/messages")} aria-label={t("chat.backToMessages")}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          {conversation ? (
            <>
              <Avatar className="h-9 w-9">
                <AvatarImage src={conversation.other_party_avatar || undefined} alt="" />
                <AvatarFallback>{conversation.other_party_name.charAt(0)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                {otherLink ? (
                  <Link to={otherLink} className="block truncate font-semibold hover:underline">
                    {conversation.other_party_name}
                  </Link>
                ) : (
                  <p className="truncate font-semibold">{conversation.other_party_name}</p>
                )}
                {otherTyping ? (
                  <p className="truncate text-xs text-primary">{t("chat.typing")}</p>
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
            <Skeleton className="h-9 w-40" />
          )}
          {conversation?.role === "support_team" && conversation.other_party_id && (
            <Button size="sm" className="ml-auto flex-shrink-0" onClick={() => setOrderOpen(true)}>
              <ShoppingBag className="mr-1 h-4 w-4" />
              {t("chat.createOrder")}
            </Button>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 space-y-2 overflow-y-auto px-3 py-4">
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
                    <p className="my-3 text-center text-xs text-muted-foreground">{format(created, "EEE, MMM d")}</p>
                  )}
                  <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
                    <MessageBubble message={message} mine={mine} onOpenImage={setLightboxSrc} />
                  </div>
                </div>
              );
            })
          )}

          {otherTyping && (
            <div className="flex justify-start animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
              <div className="rounded-2xl rounded-bl-sm bg-muted" role="status" aria-label={t("chat.typing")}>
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
            className="absolute bottom-24 right-4 z-10 rounded-full bg-primary p-2 text-primary-foreground shadow-lg transition-colors animate-in zoom-in-75 duration-200 hover:bg-primary/90"
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
          <div className="border-t bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {/* Image preview (the text box below becomes its caption) */}
            {imagePreview && (
              <div className="mb-2 flex items-center gap-2 rounded-xl border bg-muted/50 p-2 animate-in slide-in-from-bottom-2 duration-200">
                <img src={imagePreview.url} alt="" className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
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
              /* Recording in progress */
              <div className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 animate-in fade-in-0 duration-200 dark:border-red-900 dark:bg-red-950">
                <span className="h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-red-500" />
                <Mic className="h-4 w-4 flex-shrink-0 animate-wiggle text-red-600" />
                <span className="flex-1 text-sm font-medium tabular-nums text-red-700 dark:text-red-200">
                  {t("chat.recording")} {formatDuration(recordingTime)}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-red-700 hover:bg-red-100 dark:text-red-200"
                  onClick={() => stopRecording(true)}
                  aria-label={t("chat.cancelRecording")}
                  title={t("chat.cancelRecording")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-xl border-red-300 text-xs text-red-700 hover:bg-red-100"
                  onClick={() => stopRecording(false)}
                >
                  <Square className="mr-1 h-3 w-3 fill-current" />
                  {t("chat.stop")}
                </Button>
              </div>
            ) : voiceNote ? (
              /* Recorded, ready to send */
              <div className="flex items-center gap-2 rounded-2xl border bg-muted/50 p-2 animate-in slide-in-from-bottom-2 duration-200">
                <Mic className="h-4 w-4 flex-shrink-0 text-primary" />
                <audio controls src={voiceNote.url} className="h-8 min-w-0 flex-1" />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={discardVoiceNote}
                  disabled={uploading}
                  aria-label={t("chat.discardVoice")}
                  title={t("chat.discardVoice")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button size="icon" onClick={sendVoiceNote} disabled={busy} aria-label={t("chat.send")}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            ) : (
              /* Text / image composer */
              <div className="flex items-end gap-2">
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
                  className="flex-shrink-0"
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
                  className="max-h-32 min-h-[40px] resize-none"
                />
                {canRecord ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="flex-shrink-0"
                    onClick={startRecording}
                    disabled={busy}
                    aria-label={t("chat.recordVoice")}
                    title={t("chat.recordVoice")}
                  >
                    <Mic className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    className="flex-shrink-0"
                    onClick={handleSend}
                    disabled={busy || (!draft.trim() && !imagePreview)}
                    aria-label={t("chat.send")}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
    </MobileLayout>
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
        "max-w-[80%] whitespace-pre-wrap break-words rounded-2xl text-sm",
        isImage ? "overflow-hidden p-1" : "px-3 py-2",
        mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted",
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

  return (
    <div className="flex items-center gap-2 py-0.5">
      <Mic className={cn("h-4 w-4 flex-shrink-0", mine ? "text-primary-foreground/80" : "text-primary")} />
      {isLoading ? (
        <Skeleton className="h-8 w-[180px]" />
      ) : isError || !src ? (
        <span className="text-xs opacity-80">{t("chat.mediaUnavailable")}</span>
      ) : (
        <audio
          controls
          preload="metadata"
          src={src}
          className="h-8 w-[200px] max-w-full"
          aria-label={t("chat.voiceNote")}
        />
      )}
    </div>
  );
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
