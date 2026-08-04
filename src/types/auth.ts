/**
 * Authenticated principal attached to Express Request by the middleware.
 *
 * `userId` is the internal PostgreSQL User.id.
 * `authUserId` is the immutable Supabase Auth user ID.
 * `role` is the server-verified role from PostgreSQL (never from JWT claims).
 */
export interface AuthPrincipal {
  userId: string;
  authUserId: string;
  role: 'CLIENT' | 'AGENT' | 'ADMIN' | 'WORKER';
}
