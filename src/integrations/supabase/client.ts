// D4EXAM Supabase client — browser + Capacitor APK
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';

/**
 * Single source of truth for the live project.
 * Never mix URL/key from different projects (causes "Invalid API key").
 */
export const D4_SUPABASE_URL = 'https://unojhweoayjxirngcmrm.supabase.co';
export const D4_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVub2pod2VvYXlqeGlybmdjbXJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzNzIzMzksImV4cCI6MjEwNjk0ODMzOX0.2uf62fYsG1r7wt675RPpDRTuAPdeyvkX5_hU6hCQucQ';

function isNativeAppShell(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if ((window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA) return true;
    const Cap = (window as unknown as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        getPlatform?: () => string;
      };
    }).Capacitor;
    if (Cap?.isNativePlatform?.()) return true;
    if ((Cap?.getPlatform?.() || '').toLowerCase() === 'android') return true;
    if ((Cap?.getPlatform?.() || '').toLowerCase() === 'ios') return true;
    const ua = navigator.userAgent || '';
    if (ua.includes('; wv)') && /Android/i.test(ua)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    headers.set('apikey', supabaseKey);
    if (!headers.get('Authorization')) {
      headers.set('Authorization', `Bearer ${supabaseKey}`);
    }
    return fetch(input, { ...init, headers });
  };
}

function createSupabaseClient() {
  // ALWAYS use canonical project. Env mismatch is the root of APK "Invalid API key"
  // and the cascade error "School code not found".
  const url = D4_SUPABASE_URL;
  const key = D4_SUPABASE_ANON_KEY;
  const native = isNativeAppShell();

  const storage = native
    ? typeof window !== 'undefined'
      ? localStorage
      : undefined
    : brokeredPreviewStorage();

  return createClient<Database>(url, key, {
    global: {
      fetch: createSupabaseFetch(key),
    },
    auth: {
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: !native,
      flowType: 'pkce',
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
