-- AlterTable: Add evidence file paths array to Complaint
ALTER TABLE "Complaint" ADD COLUMN "evidenceFilePaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
