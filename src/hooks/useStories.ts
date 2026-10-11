import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Database } from "@/integrations/supabase/types";
import { compressImage } from "@/lib/compressImage";

type Functions = Database["public"]["Functions"];
export type StoryRing = Functions["story_rings"]["Returns"][number];
export type LiveStory = Functions["vendor_live_stories"]["Returns"][number];
export type MyStory = Functions["my_stories"]["Returns"][number];

/** Story photos are shown full-screen on phones; 1440px on the long side is plenty. */
const STORY_MAX_DIMENSION = 1440;
const STORY_BUCKET = "product-images";
export const STORY_CAPTION_MAX = 200;
const RINGS_LIMIT = 30;
const RINGS_REFRESH_MS = 60_000;

export const STORY_RINGS_KEY = ["story-rings"] as const;
const liveStoriesKey = (vendorId: string | undefined) => ["vendor-stories", vendorId] as const;
const MY_STORIES_KEY = ["my-stories"] as const;

/** Sellers with a live story, for the rings on the home page and shop pages. */
export function useStoryRings() {
  const { user } = useAuth();
  return useQuery({
    // Who you are changes which rings are "seen".
    queryKey: [...STORY_RINGS_KEY, user?.id ?? "guest"],
    queryFn: async (): Promise<StoryRing[]> => {
      const { data, error } = await supabase.rpc("story_rings", { p_limit: RINGS_LIMIT });
      if (error) {
        console.error("[stories] could not load story rings", error);
        throw error;
      }
      return data ?? [];
    },
    staleTime: RINGS_REFRESH_MS,
  });
}

/** One seller's live stories, in the order they play. */
export function useVendorStories(vendorId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [...liveStoriesKey(vendorId), user?.id ?? "guest"],
    queryFn: async (): Promise<LiveStory[]> => {
      const { data, error } = await supabase.rpc("vendor_live_stories", { p_vendor_id: vendorId! });
      if (error) {
        console.error("[stories] could not load stories", { vendorId, error });
        throw error;
      }
      return data ?? [];
    },
    enabled: !!vendorId,
  });
}

export function useStoryActions(vendorId: string | undefined) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const key = [...liveStoriesKey(vendorId), user?.id ?? "guest"];

  const markViewed = (storyId: string) => {
    if (!user) return;
    supabase.rpc("mark_story_viewed", { p_story_id: storyId }).then(({ error }) => {
      if (error) console.warn("[stories] could not record view", { storyId, error });
      else queryClient.invalidateQueries({ queryKey: STORY_RINGS_KEY });
    });
  };

  const like = useMutation({
    mutationFn: async ({ storyId, liked }: { storyId: string; liked: boolean }) => {
      const { data, error } = await supabase.rpc("set_story_like", { p_story_id: storyId, p_liked: liked });
      if (error) throw new Error(error.message);
      return data;
    },
    // Show the heart straight away; undo if the server says no.
    onMutate: ({ storyId, liked }) => {
      const previous = queryClient.getQueryData<LiveStory[]>(key);
      queryClient.setQueryData<LiveStory[]>(key, (old = []) =>
        old.map((s) =>
          s.id === storyId && s.liked_by_me !== liked
            ? { ...s, liked_by_me: liked, like_count: Math.max(0, s.like_count + (liked ? 1 : -1)) }
            : s,
        ),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      console.error("[stories] like failed", error);
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (count, { storyId }) => {
      queryClient.setQueryData<LiveStory[]>(key, (old = []) => old.map((s) => (s.id === storyId ? { ...s, like_count: count } : s)));
    },
  });

  return { markViewed, like };
}

/** The signed-in seller's own stories with stats, plus post / remove. */
export function useMyStories() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const stories = useQuery({
    queryKey: MY_STORIES_KEY,
    queryFn: async (): Promise<MyStory[]> => {
      const { data, error } = await supabase.rpc("my_stories", {});
      if (error) {
        console.error("[stories] could not load my stories", error);
        throw error;
      }
      return data ?? [];
    },
    enabled: !!user,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: MY_STORIES_KEY });
    queryClient.invalidateQueries({ queryKey: STORY_RINGS_KEY });
    queryClient.invalidateQueries({ queryKey: ["vendor-stories", user?.id] });
  };

  const post = useMutation({
    mutationFn: async ({ file, caption }: { file: File; caption: string }) => {
      if (!user) throw new Error("Please sign in again");
      if (!file.type.startsWith("image/")) throw new Error("Please choose a photo");
      const photo = await compressImage(file, { maxDimension: STORY_MAX_DIMENSION });
      const ext = photo.type === "image/webp" ? "webp" : photo.type === "image/png" ? "png" : "jpg";
      const path = `${user.id}/stories/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const { error: uploadError } = await supabase.storage.from(STORY_BUCKET).upload(path, photo, { contentType: photo.type, upsert: false });
      if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
      const imageUrl = supabase.storage.from(STORY_BUCKET).getPublicUrl(path).data.publicUrl;
      const { data, error } = await supabase.rpc("create_story", { p_image_url: imageUrl, p_caption: caption.trim() || undefined });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: async (storyId: string) => {
      const { error } = await supabase.rpc("remove_story", { p_story_id: storyId });
      if (error) throw new Error(error.message);
    },
    onSuccess: refresh,
  });

  return { stories, post, remove };
}

export type StoryViewer = Functions["story_viewers"]["Returns"][number];

/** Who viewed one of my stories (people who liked it first). */
export function useStoryViewers(storyId: string | null) {
  return useQuery({
    queryKey: ["story-viewers", storyId],
    queryFn: async (): Promise<StoryViewer[]> => {
      const { data, error } = await supabase.rpc("story_viewers", { p_story_id: storyId! });
      if (error) {
        console.error("[stories] could not load viewers", { storyId, error });
        throw error;
      }
      return data ?? [];
    },
    enabled: !!storyId,
  });
}
