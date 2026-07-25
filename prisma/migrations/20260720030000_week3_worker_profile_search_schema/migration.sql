-- CreateEnum
CREATE TYPE "ReferenceCheckStatus" AS ENUM ('UNVERIFIED', 'CONTACTED', 'CONFIRMED', 'FAILED');

-- AlterTable
ALTER TABLE "WorkerProfile" ADD COLUMN     "cnicNumber" TEXT,
ADD COLUMN     "cnicFrontPath" TEXT,
ADD COLUMN     "cnicBackPath" TEXT,
ADD COLUMN     "referenceName" TEXT,
ADD COLUMN     "referencePhone" TEXT,
ADD COLUMN     "referenceStatus" "ReferenceCheckStatus" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "referenceVerifiedById" TEXT,
ADD COLUMN     "referenceVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "identityChecked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phoneConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "backgroundChecked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "skillAssessed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
ADD COLUMN     "ratingCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "completedJobsCount" INTEGER NOT NULL DEFAULT 0;

-- Add CHECK constraints for data integrity
ALTER TABLE "WorkerProfile" ADD CONSTRAINT "WorkerProfile_rating_range_check" CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "WorkerProfile" ADD CONSTRAINT "WorkerProfile_ratingCount_nonnegative_check" CHECK ("ratingCount" >= 0);
ALTER TABLE "WorkerProfile" ADD CONSTRAINT "WorkerProfile_completedJobsCount_nonnegative_check" CHECK ("completedJobsCount" >= 0);

-- CreateTable
CREATE TABLE "worker_categories" (
    "workerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "worker_categories_pkey" PRIMARY KEY ("workerId","categoryId")
);

-- CreateTable
CREATE TABLE "worker_service_areas" (
    "workerId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,

    CONSTRAINT "worker_service_areas_pkey" PRIMARY KEY ("workerId","areaId")
);

-- CreateIndex
CREATE INDEX "worker_categories_categoryId_idx" ON "worker_categories"("categoryId");

-- CreateIndex
CREATE INDEX "worker_service_areas_areaId_idx" ON "worker_service_areas"("areaId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerProfile_cnicNumber_key" ON "WorkerProfile"("cnicNumber");

-- CreateIndex
CREATE INDEX "WorkerProfile_status_rating_completedJobsCount_idx" ON "WorkerProfile"("status", "rating" DESC, "completedJobsCount" DESC);

-- AddForeignKey
ALTER TABLE "WorkerProfile" ADD CONSTRAINT "WorkerProfile_referenceVerifiedById_fkey" FOREIGN KEY ("referenceVerifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_categories" ADD CONSTRAINT "worker_categories_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_categories" ADD CONSTRAINT "worker_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_service_areas" ADD CONSTRAINT "worker_service_areas_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_service_areas" ADD CONSTRAINT "worker_service_areas_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;