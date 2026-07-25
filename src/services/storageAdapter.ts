/**
 * Storage adapter abstraction for private CNIC document uploads.
 *
 * This narrow interface allows the storage boundary to be replaced
 * in tests with a fake adapter. The worker service depends on this
 * abstraction rather than calling Supabase directly in routes.
 */

export interface UploadResult {
  path: string;
}

export interface StorageAdapter {
  /**
   * Upload a private object to the configured bucket.
   * Returns the storage path on success.
   */
  uploadPrivateObject(
    path: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<UploadResult>;

  /**
   * Remove a private object from the configured bucket.
   * Should not throw if the object does not exist.
   */
  removePrivateObject(path: string): Promise<void>;
}
