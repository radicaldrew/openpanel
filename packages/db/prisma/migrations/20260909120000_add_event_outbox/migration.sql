-- AlterTable
ALTER TABLE "public"."projects" ADD COLUMN     "gtmTenantId" UUID,
ADD COLUMN     "gtmTenantSlug" TEXT;
-- CreateTable
CREATE TABLE "public"."event_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "tenantSlug" TEXT NOT NULL,
    "tenantId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "event_outbox_eventId_key" ON "public"."event_outbox"("eventId");
-- CreateIndex
CREATE INDEX "event_outbox_status_nextAttemptAt_idx" ON "public"."event_outbox"("status", "nextAttemptAt");
-- CreateIndex
CREATE INDEX "event_outbox_projectId_createdAt_idx" ON "public"."event_outbox"("projectId", "createdAt");
-- AddForeignKey
ALTER TABLE "public"."event_outbox" ADD CONSTRAINT "event_outbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
