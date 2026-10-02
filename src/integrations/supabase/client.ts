// D4EXAM Supabase browser client
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { brokeredPreviewStorage } from './previewAuthStorage';

/** Canonical project (must match JWT `ref` claim). */
const CANONICAL_URL = 'https://rqjchjytqcqjmljahcdr.supabase.co';
const CANONICAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxamNoanl0cWNxam1samFoY2RyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMjAwMzMsImV4cCI6MjEwMjU5NjAzM30.JWffmq5TIUnizWR-DIhwLylmHPmuuks2kUuEDEidlE8';
const CANONICAL_PUBLISHABLE = 'sb_publishable_VQOWXfgqJsrehi2sJGkdig_Gr8Zilr2';

function isJwtKey(value: string): boolean {
  return value.startsWith('eyJ');
}

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

/** Extract project ref from a classic JWT anon/service key. */
function refFromJwt(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.ref === 'string' ? json.ref : null;
  } catch {
    return null;
  }
}

function isApkOrLocalHost(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if ((window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA) return true;
    const host = (window.location.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '') return true;
    if (window.location.protocol === 'file:') return true;
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (cap?.isNativePlatform?.()) return true;
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
    // Opaque sb_ keys must not be sent as Bearer
    if (isNewSupabaseApiKey(supabaseKey) && headers.get('Authorization') === `Bearer ${supabaseKey}`) {
      headers.delete('Authorization');
    }
    headers.set('apikey', supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createSupabaseClient() {
  const envUrl = String(
    (import.meta.env['VITE_SUPABASE_URL'] as string | undefined) ||
      (typeof process !== 'undefined' ? process.env?.['SUPABASE_URL'] : '') ||
      '',
  ).trim();
  const envAnon = String(
    (import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined) ||
      (typeof process !== 'undefined' ? process.env?.['SUPABASE_ANON_KEY'] : '') ||
      '',
  ).trim();
  const envPub = String(
    (import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY'] as string | undefined) ||
      (typeof process !== 'undefined' ? process.env?.['SUPABASE_PUBLISHABLE_KEY'] : '') ||
      '',
  ).trim();

  // Prefer classic JWT anon key (required for reliable password auth in WebView/APK)
  let authKey = isJwtKey(envAnon) ? envAnon : CANONICAL_ANON_KEY;
  const jwtRef = refFromJwt(authKey);

  // URL must match the JWT project ref — never mix projects (causes "Invalid API key")
  let url = envUrl || CANONICAL_URL;
  if (jwtRef && !url.includes(jwtRef)) {
    console.warn(
      `[Supabase] URL ${url} does not match anon key ref ${jwtRef}; using canonical project`,
    );
    url = `https://${jwtRef}.supabase.co`;
    authKey = CANONICAL_ANON_KEY;
  }
  if (!url.includes('rqjchjytqcqjmljahcdr') && !jwtRef) {
    url = CANONICAL_URL;
    authKey = CANONICAL_ANON_KEY;
  }

  const apk = isApkOrLocalHost();
  const storage = apk
    ? typeof window !== 'undefined'
      ? localStorage
      : undefined
    : brokeredPreviewStorage();

  return createClient<Database>(url, authKey, {
    global: {
      fetch: createSupabaseFetch(authKey),
    },
    auth: {
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: !apk,
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
