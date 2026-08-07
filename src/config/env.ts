/**
 * Centralized environment configuration validation.
 *
 * Fails fast when required values are missing.
 * Never prints secret values — only the key names.
 */

/** Backend-only keys that must always be present. */
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
] as const;

/** Keys that are required in staging and production but optional in development. */
const STAGING_PRODUCTION_KEYS = ['SUPABASE_SERVICE_ROLE_KEY'] as const;

/** Keys that have safe defaults. */
const OPTIONAL_KEYS_WITH_DEFAULTS = {
  PORT: '3000',
  NODE_ENV: 'development',
} as const;

/**
 * Keys whose values must never be exposed to frontend/client code.
 * The service-role key in particular grants full Supabase access.
 */
export const BACKEND_ONLY_KEYS = ['SUPABASE_SERVICE_ROLE_KEY'] as const;

interface EnvConfig {
  databaseUrl: string;
  directUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey?: string;
  port: number;
  nodeEnv: string;
  isProduction: boolean;
  isStaging: boolean;
}

function validateEnv(): EnvConfig {
  const missing: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  const nodeEnv = process.env.NODE_ENV || OPTIONAL_KEYS_WITH_DEFAULTS.NODE_ENV;
  const isProduction = nodeEnv === 'production';
  const isStaging = nodeEnv === 'staging';

  // Require service-role key in staging and production
  if (isProduction || isStaging) {
    for (const key of STAGING_PRODUCTION_KEYS) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }
  }

  if (missing.length > 0) {
    // Print key names only — never values.
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}.\n` +
        `Copy .env.example to .env and fill in the values.`,
    );
  }

  return {
    databaseUrl: process.env.DATABASE_URL!,
    directUrl: process.env.DIRECT_URL!,
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    port: parseInt(process.env.PORT || OPTIONAL_KEYS_WITH_DEFAULTS.PORT, 10),
    nodeEnv,
    isProduction,
    isStaging,
  };
}

/** Validated environment configuration. Evaluated on first import. */
export const env = validateEnv();
