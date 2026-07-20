-- Add unique constraint on WorkerProfile.phone and suspensionReason column

-- Ensure no duplicate worker phone numbers
CREATE UNIQUE INDEX "WorkerProfile_phone_key" ON "WorkerProfile"("phone");

-- Track the reason for suspension
ALTER TABLE "WorkerProfile" ADD COLUMN "suspensionReason" TEXT;
