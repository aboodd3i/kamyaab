-- DropIndex
DROP INDEX "WorkerProfile_status_rating_completedJobsCount_idx";

-- CreateIndex
CREATE INDEX "WorkerProfile_status_rating_completedJobsCount_idx" ON "WorkerProfile"("status", "rating", "completedJobsCount");
