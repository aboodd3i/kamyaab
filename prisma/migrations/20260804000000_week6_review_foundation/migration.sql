-- CreateEnum
CREATE TYPE "ReviewDirection" AS ENUM ('CLIENT_TO_WORKER', 'WORKER_TO_CLIENT');

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "revieweeUserId" TEXT NOT NULL,
    "direction" "ReviewDirection" NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_bookingId_direction_key" ON "Review"("bookingId", "direction");
CREATE INDEX "Review_reviewerUserId_idx" ON "Review"("reviewerUserId");
CREATE INDEX "Review_revieweeUserId_idx" ON "Review"("revieweeUserId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_revieweeUserId_fkey" FOREIGN KEY ("revieweeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
