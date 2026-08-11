import { createClient, SupabaseClient } from '@supabase/supabase-js'

export const supabaseUrl = String(import.meta.env?.VITE_SUPABASE_URL || '').trim()
export const supabaseAnonKey = String(import.meta.env?.VITE_SUPABASE_ANON_KEY || '').trim()

export const supabaseConfigurationError =
  !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !supabaseAnonKey
    ? 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
    : null

export const supabase: SupabaseClient = createClient(
  supabaseConfigurationError ? 'http://127.0.0.1:54321' : supabaseUrl,
  supabaseConfigurationError ? 'configuration-missing' : supabaseAnonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
)

export const BUCKET_NAME = 'qa-ephemeral-snapshots'
