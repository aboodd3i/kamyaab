-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('BOOKING_COMPLETED', 'REVIEW_CREATED', 'COMPLAINT_FILED', 'COMPLAINT_RESOLVED', 'WORKER_STATUS_CHANGED', 'INVITATION_RESPONDED');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "bookingId" TEXT,
    "reviewId" TEXT,
    "complaintId" TEXT,
    "workerId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_bookingId_idx" ON "AuditLog"("bookingId");
CREATE INDEX "AuditLog_workerId_idx" ON "AuditLog"("workerId");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
