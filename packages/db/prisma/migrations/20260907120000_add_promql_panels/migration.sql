-- AlterTable
ALTER TABLE "public"."dashboards" ADD COLUMN     "variables" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "public"."reports" ADD COLUMN     "metricQueries" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "public"."annotations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "dashboardId" TEXT,
    "time" TIMESTAMP(3) NOT NULL,
    "timeEnd" TIMESTAMP(3),
    "text" TEXT NOT NULL,
    "tags" TEXT[],
    "createdBy" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."promql_query_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expr" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promql_query_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "annotations_projectId_time_idx" ON "public"."annotations"("projectId", "time");

-- CreateIndex
CREATE INDEX "promql_query_history_projectId_userId_createdAt_idx" ON "public"."promql_query_history"("projectId", "userId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."annotations" ADD CONSTRAINT "annotations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
