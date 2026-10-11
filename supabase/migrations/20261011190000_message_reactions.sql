-- Emoji reactions on chat messages (long-press a message). One reaction per
-- person per message; reacting again replaces it, and an empty emoji removes it
-- (stored as NULL so the row can be updated in place).

CREATE TABLE IF NOT EXISTS public.message_reactions (
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji TEXT CHECK (emoji IS NULL OR char_length(emoji) BETWEEN 1 AND 16),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_conversation ON public.message_reactions(conversation_id);

ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Chat participants can see reactions"
ON public.message_reactions FOR SELECT
USING (public.can_access_conversation(conversation_id));

ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reactions;

-- React to a message (or remove your reaction with NULL / empty).
CREATE OR REPLACE FUNCTION public.set_message_reaction(p_message_id UUID, p_emoji TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_conversation UUID;
  v_emoji TEXT := NULLIF(btrim(COALESCE(p_emoji, '')), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in';
  END IF;
  SELECT conversation_id INTO v_conversation FROM public.messages WHERE id = p_message_id;
  IF v_conversation IS NULL OR NOT public.can_access_conversation(v_conversation) THEN
    RAISE EXCEPTION 'Message not found';
  END IF;
  -- Emoji only: no letters, digits, spaces or markup.
  IF v_emoji IS NOT NULL AND (char_length(v_emoji) > 16 OR v_emoji ~ '[[:alnum:][:space:]<>&"'']') THEN
    RAISE EXCEPTION 'Reactions must be an emoji';
  END IF;

  INSERT INTO public.message_reactions (message_id, conversation_id, user_id, emoji, updated_at)
  VALUES (p_message_id, v_conversation, v_uid, v_emoji, now())
  ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.set_message_reaction(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_message_reaction(UUID, TEXT) TO authenticated;
