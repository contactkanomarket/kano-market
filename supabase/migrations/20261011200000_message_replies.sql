-- Reply to a message: a message can quote an earlier one in the same chat.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES public.messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_reply_to_id_idx ON public.messages (reply_to_id) WHERE reply_to_id IS NOT NULL;

-- The quoted message must belong to the same conversation (otherwise a reply
-- could leak a message from a chat the sender can't see).
CREATE OR REPLACE FUNCTION public.check_message_reply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.reply_to_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.id = NEW.reply_to_id AND m.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'You can only reply to a message in this chat';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER messages_check_reply
  BEFORE INSERT OR UPDATE OF reply_to_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.check_message_reply();
