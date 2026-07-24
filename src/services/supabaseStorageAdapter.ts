/**
 * Supabase Storage adapter implementation.
 *
 * Uses the server-side Supabase client with the service-role key.
 * Never exposes credentials or public URLs.
 */

import { createClient } from '@supabase/supabase-js';
import type { StorageAdapter, UploadResult } from './storageAdapter';

/**
 * Create a Supabase-backed storage adapter.
 *
 * @param supabaseUrl    Supabase project URL (server-side)
 * @param serviceRoleKey Service-role key (server-only, never client-facing)
 * @param bucketName     Private bucket name for CNIC documents
 */
export function createSupabaseStorageAdapter(
  supabaseUrl: string,
  serviceRoleKey: string,
  bucketName: string,
): StorageAdapter {
  const client = createClient(supabaseUrl, serviceRoleKey);

  return {
    async uploadPrivateObject(
      path: string,
      buffer: Buffer,
      contentType: string,
    ): Promise<UploadResult> {
      const { error } = await client.storage
        .from(bucketName)
        .upload(path, buffer, {
          contentType,
          upsert: false, // never overwrite — avoid clobbering existing objects
        });

      if (error) {
        throw new Error(`Storage upload failed: ${error.message}`);
      }

      return { path };
    },

    async removePrivateObject(path: string): Promise<void> {
      const { error } = await client.storage
        .from(bucketName)
        .remove([path]);

      // Suppress not-found errors — the object may have already been removed.
      if (error && !error.message.toLowerCase().includes('not found')) {
        // Log without the path — just signal that cleanup failed.
        console.error('Storage cleanup failed for a CNIC object');
      }
    },
  };
}
