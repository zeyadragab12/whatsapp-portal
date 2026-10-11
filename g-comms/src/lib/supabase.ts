import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_KEY as string,
)

export const COMPANY_DOMAIN = '@thegdevelopments.com'
export const isCompanyEmail = (email: string) => email.trim().toLowerCase().endsWith(COMPANY_DOMAIN)
