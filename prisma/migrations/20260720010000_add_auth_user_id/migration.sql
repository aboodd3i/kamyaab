-- Add authUserId column to User table
-- This is the immutable Supabase Auth user ID used for stable identity mapping.
ALTER TABLE "User" ADD COLUMN "authUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_authUserId_key" ON "User"("authUserId");
