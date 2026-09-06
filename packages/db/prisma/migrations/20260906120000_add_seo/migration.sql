-- CreateTable
CREATE TABLE "dataforseo_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "balanceUsd" DOUBLE PRECISION,
    "balanceAt" TIMESTAMP(3),
    "lastError" TEXT,
    "monthlySpendUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spendCapUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataforseo_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_project_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "locationCode" INTEGER NOT NULL DEFAULT 2840,
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "devices" TEXT NOT NULL DEFAULT 'both',
    "serpDepth" INTEGER NOT NULL DEFAULT 20,
    "rankSchedule" TEXT NOT NULL DEFAULT 'daily',
    "rankNextRunAt" TIMESTAMP(3),
    "rankLastRunAt" TIMESTAMP(3),
    "backlinkSchedule" TEXT NOT NULL DEFAULT 'weekly',
    "backlinkNextRunAt" TIMESTAMP(3),
    "competitors" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seo_project_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_tracked_keywords" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "tags" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'manual',
    "searchVolume" INTEGER,
    "difficulty" INTEGER,
    "cpc" DOUBLE PRECISION,
    "metricsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seo_tracked_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_rank_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "keywordsTotal" INTEGER NOT NULL DEFAULT 0,
    "keywordsChecked" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "seo_rank_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_audits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "dfsTaskId" TEXT,
    "status" TEXT NOT NULL,
    "maxPages" INTEGER NOT NULL DEFAULT 500,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER,
    "summary" JSONB,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "seo_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dataforseo_connections_organizationId_key" ON "dataforseo_connections"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "seo_project_configs_projectId_key" ON "seo_project_configs"("projectId");

-- CreateIndex
CREATE INDEX "seo_tracked_keywords_projectId_isActive_idx" ON "seo_tracked_keywords"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "seo_tracked_keywords_projectId_keyword_key" ON "seo_tracked_keywords"("projectId", "keyword");

-- CreateIndex
CREATE INDEX "seo_rank_runs_projectId_startedAt_idx" ON "seo_rank_runs"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "seo_audits_projectId_startedAt_idx" ON "seo_audits"("projectId", "startedAt");

-- AddForeignKey
ALTER TABLE "dataforseo_connections" ADD CONSTRAINT "dataforseo_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_project_configs" ADD CONSTRAINT "seo_project_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_tracked_keywords" ADD CONSTRAINT "seo_tracked_keywords_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_rank_runs" ADD CONSTRAINT "seo_rank_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_audits" ADD CONSTRAINT "seo_audits_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
