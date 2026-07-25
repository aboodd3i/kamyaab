-- Week 4: Job Requests & Booking Flow (Specific Worker)
-- ============================================================
-- Adds 5 enums and 3 tables: JobRequest, JobInvitation, Booking
-- Also adds back-relation columns (no data change) to existing tables.

-- ─── Enums ────────────────────────────────────────────────────────────────

-- Job request type: specific worker (Flow A) or open/broadcast (Flow B, Week 5)
CREATE TYPE "JobRequestType" AS ENUM ('SPECIFIC_WORKER', 'OPEN');

-- Job request lifecycle
CREATE TYPE "JobRequestStatus" AS ENUM (
  'DRAFT',
  'WORKER_CONTACTED',
  'ACCEPTED',
  'EXPIRED',
  'CANCELLED'
);

-- How urgently the client needs the work done
CREATE TYPE "UrgencyLevel" AS ENUM ('FLEXIBLE', 'THIS_WEEK', 'URGENT');

-- Invitation lifecycle
CREATE TYPE "InvitationStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED'
);

-- Booking lifecycle
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'COMPLETED', 'CANCELLED');

-- ─── Tables ───────────────────────────────────────────────────────────────

-- JobRequest: a job posted by a client (draft or submitted)
CREATE TABLE "JobRequest" (
  "id"             TEXT NOT NULL,
  "clientId"       TEXT NOT NULL,
  "categoryId"     TEXT NOT NULL,
  "areaId"         TEXT NOT NULL,
  "description"    TEXT NOT NULL,
  "urgency"        "UrgencyLevel"     NOT NULL DEFAULT 'FLEXIBLE',
  "budget"         DECIMAL(10,2),
  "type"           "JobRequestType"   NOT NULL DEFAULT 'SPECIFIC_WORKER',
  "status"         "JobRequestStatus" NOT NULL DEFAULT 'DRAFT',
  "targetWorkerId" TEXT,
  "submittedAt"    TIMESTAMP(3),
  "expiresAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JobRequest_pkey" PRIMARY KEY ("id")
);

-- JobInvitation: sent to a worker for a specific job request
CREATE TABLE "JobInvitation" (
  "id"           TEXT NOT NULL,
  "jobRequestId" TEXT NOT NULL,
  "workerId"     TEXT NOT NULL,
  "status"       "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "smsSentAt"    TIMESTAMP(3),
  "respondedAt"  TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JobInvitation_pkey" PRIMARY KEY ("id"),
  -- One invitation per worker per job
  CONSTRAINT "JobInvitation_jobRequestId_workerId_key" UNIQUE ("jobRequestId", "workerId")
);

-- Booking: created when a worker accepts an invitation; contact is released
CREATE TABLE "Booking" (
  "id"           TEXT NOT NULL,
  "jobRequestId" TEXT NOT NULL,
  "invitationId" TEXT NOT NULL,
  "workerId"     TEXT NOT NULL,
  "status"       "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
  "clientPhone"  TEXT,
  "workerPhone"  TEXT,
  "confirmedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"  TIMESTAMP(3),
  "cancelledAt"  TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Booking_pkey"                   PRIMARY KEY ("id"),
  CONSTRAINT "Booking_jobRequestId_key"       UNIQUE ("jobRequestId"),
  CONSTRAINT "Booking_invitationId_key"       UNIQUE ("invitationId")
);

-- ─── Indexes ──────────────────────────────────────────────────────────────

-- JobRequest: client's "My Jobs" list query
CREATE INDEX "JobRequest_clientId_status_idx"   ON "JobRequest"("clientId", "status");
-- JobRequest: expiry background job
CREATE INDEX "JobRequest_status_expiresAt_idx"  ON "JobRequest"("status", "expiresAt");

-- JobInvitation: worker's pending-invitations inbox
CREATE INDEX "JobInvitation_workerId_status_idx"   ON "JobInvitation"("workerId", "status");
-- JobInvitation: expiry job — find stale PENDING invitations
CREATE INDEX "JobInvitation_status_createdAt_idx"  ON "JobInvitation"("status", "createdAt");

-- Booking: worker's booking history
CREATE INDEX "Booking_workerId_status_idx"  ON "Booking"("workerId", "status");

-- ─── Foreign Keys ─────────────────────────────────────────────────────────

-- JobRequest → ClientProfile
ALTER TABLE "JobRequest"
  ADD CONSTRAINT "JobRequest_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "ClientProfile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- JobRequest → Category
ALTER TABLE "JobRequest"
  ADD CONSTRAINT "JobRequest_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- JobRequest → Area
ALTER TABLE "JobRequest"
  ADD CONSTRAINT "JobRequest_areaId_fkey"
  FOREIGN KEY ("areaId") REFERENCES "Area"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- JobRequest → WorkerProfile (target worker, Flow A)
ALTER TABLE "JobRequest"
  ADD CONSTRAINT "JobRequest_targetWorkerId_fkey"
  FOREIGN KEY ("targetWorkerId") REFERENCES "WorkerProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- JobInvitation → JobRequest
ALTER TABLE "JobInvitation"
  ADD CONSTRAINT "JobInvitation_jobRequestId_fkey"
  FOREIGN KEY ("jobRequestId") REFERENCES "JobRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- JobInvitation → WorkerProfile
ALTER TABLE "JobInvitation"
  ADD CONSTRAINT "JobInvitation_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "WorkerProfile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Booking → JobRequest (1:1)
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_jobRequestId_fkey"
  FOREIGN KEY ("jobRequestId") REFERENCES "JobRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Booking → JobInvitation (1:1)
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_invitationId_fkey"
  FOREIGN KEY ("invitationId") REFERENCES "JobInvitation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Booking → WorkerProfile
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "WorkerProfile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Data integrity constraints ────────────────────────────────────────────

-- Budget must be positive if provided
ALTER TABLE "JobRequest"
  ADD CONSTRAINT "JobRequest_budget_positive_check"
  CHECK ("budget" IS NULL OR "budget" > 0);
