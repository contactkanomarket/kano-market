import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { json } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

// Deletes story photos from storage once they are older than 30 days.
// Called once a day by pg_cron (public.run_story_cleanup) with the same
// x-push-secret the notifications trigger uses. The story rows stay (with
// photo_deleted_at set) so sellers' view and like counts are kept.

const BUCKET = 'product-images';
const RETENTION_DAYS = 30;
/** Storage remove() accepts up to 1000 paths; stay well under per run. */
const BATCH_SIZE = 200;
const PUBLIC_PREFIX = `/storage/v1/object/public/${BUCKET}/`;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** "https://…/object/public/product-images/<uid>/stories/x.jpg" -> "<uid>/stories/x.jpg" */
function storagePath(imageUrl: string): string | null {
  const at = imageUrl.indexOf(PUBLIC_PREFIX);
  if (at === -1) return null;
  const path = decodeURIComponent(imageUrl.slice(at + PUBLIC_PREFIX.length).split('?')[0]);
  // Only ever delete files inside a stories folder.
  return /^[0-9a-f-]{36}\/stories\/[^/]+$/i.test(path) ? path : null;
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const db = serviceClient();
  try {
    const { data: config, error: configError } = await db.from('push_config').select('hook_secret').eq('id', 1).maybeSingle();
    if (configError) throw configError;
    const secret = req.headers.get('x-push-secret') ?? '';
    if (!config?.hook_secret || !secret || !safeEqual(secret, config.hook_secret)) {
      return json({ success: false, error: 'Forbidden' }, 403);
    }

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: stories, error } = await db
      .from('vendor_stories')
      .select('id, image_url')
      .is('photo_deleted_at', null)
      .lt('created_at', cutoff)
      .limit(BATCH_SIZE);
    if (error) throw error;
    if (!stories?.length) return json({ success: true, removed: 0 });

    const paths = stories.map((s) => storagePath(s.image_url)).filter((p): p is string => !!p);
    if (paths.length) {
      const { error: removeError } = await db.storage.from(BUCKET).remove(paths);
      if (removeError) throw removeError;
    }
    const { error: markError } = await db
      .from('vendor_stories')
      .update({ photo_deleted_at: new Date().toISOString() })
      .in('id', stories.map((s) => s.id));
    if (markError) throw markError;

    console.log('[story-cleanup] removed old story photos', { stories: stories.length, files: paths.length });
    return json({ success: true, removed: paths.length, more: stories.length === BATCH_SIZE });
  } catch (error) {
    console.error('[story-cleanup] failed', error);
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
