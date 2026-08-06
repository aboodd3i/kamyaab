-- AlterTable
-- Add jobRequestId column to AuditLog for tracing job-related actions
ALTER TABLE "AuditLog" ADD COLUMN "jobRequestId" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_jobRequestId_idx" ON "AuditLog"("jobRequestId");
