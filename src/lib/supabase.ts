import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

export const supabase =
  env.supabaseUrl && env.supabaseAnonKey
    ? createClient(env.supabaseUrl, env.supabaseAnonKey)
    : undefined;