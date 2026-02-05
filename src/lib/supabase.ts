import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: true,
    },
    global: {
        // Force no-cache for all requests to ensure Realtime sync works instantly
        fetch: (url, options) => {
            return fetch(url, {
                ...options,
                cache: 'no-store',
            })
        }
    }
})
