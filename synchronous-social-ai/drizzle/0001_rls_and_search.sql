-- Row-level security: defense in depth for tenant isolation.
-- The application sets app.workspace_id per transaction (see src/server/db/tenant.ts).
-- System code paths (auth lookup, webhooks, queue claim) set app.rls_bypass explicitly.
-- NOTE: superusers bypass RLS. Production must connect as a non-superuser role.

ALTER TABLE "workspace_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_memberships_tenant_isolation" ON "workspace_memberships" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "invitations_tenant_isolation" ON "invitations" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "company_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "company_profiles_tenant_isolation" ON "company_profiles" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "knowledge_sources_tenant_isolation" ON "knowledge_sources" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "knowledge_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "knowledge_documents_tenant_isolation" ON "knowledge_documents" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "knowledge_chunks_tenant_isolation" ON "knowledge_chunks" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "company_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_facts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "company_facts_tenant_isolation" ON "company_facts" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "brand_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "brand_rules_tenant_isolation" ON "brand_rules" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "products_tenant_isolation" ON "products" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "allowed_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "allowed_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "allowed_domains_tenant_isolation" ON "allowed_domains" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "connected_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connected_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "connected_accounts_tenant_isolation" ON "connected_accounts" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "oauth_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "oauth_grants_tenant_isolation" ON "oauth_grants" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "provider_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_capabilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "provider_capabilities_tenant_isolation" ON "provider_capabilities" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "provider_sync_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_sync_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "provider_sync_states_tenant_isolation" ON "provider_sync_states" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agents_tenant_isolation" ON "agents" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_runs_tenant_isolation" ON "agent_runs" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "agent_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_messages_tenant_isolation" ON "agent_messages" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "tool_invocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_invocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tool_invocations_tenant_isolation" ON "tool_invocations" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaigns_tenant_isolation" ON "campaigns" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "promotion_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promotion_offers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "promotion_offers_tenant_isolation" ON "promotion_offers" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "content_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "content_items_tenant_isolation" ON "content_items" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "content_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "content_versions_tenant_isolation" ON "content_versions" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_assets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_assets_tenant_isolation" ON "media_assets" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "media_generation_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_generation_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_generation_jobs_tenant_isolation" ON "media_generation_jobs" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_isolation" ON "approval_requests" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "approval_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "approval_decisions_tenant_isolation" ON "approval_decisions" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "automation_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "automation_rules_tenant_isolation" ON "automation_rules" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "automation_rule_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_rule_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "automation_rule_versions_tenant_isolation" ON "automation_rule_versions" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "external_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "external_actions_tenant_isolation" ON "external_actions" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "contact_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "contact_records_tenant_isolation" ON "contact_records" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "inbox_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbox_conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "inbox_conversations_tenant_isolation" ON "inbox_conversations" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "inbox_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbox_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "inbox_messages_tenant_isolation" ON "inbox_messages" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "reply_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reply_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "reply_drafts_tenant_isolation" ON "reply_drafts" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "crm_sync_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm_sync_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "crm_sync_events_tenant_isolation" ON "crm_sync_events" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ad_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ad_campaigns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ad_campaigns_tenant_isolation" ON "ad_campaigns" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ad_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ad_sets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ad_sets_tenant_isolation" ON "ad_sets" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ad_creatives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ad_creatives" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ad_creatives_tenant_isolation" ON "ad_creatives" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ad_action_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ad_action_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ad_action_requests_tenant_isolation" ON "ad_action_requests" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ad_metrics_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ad_metrics_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ad_metrics_snapshots_tenant_isolation" ON "ad_metrics_snapshots" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "content_metrics_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_metrics_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "content_metrics_snapshots_tenant_isolation" ON "content_metrics_snapshots" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "usage_events_tenant_isolation" ON "usage_events" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notifications_tenant_isolation" ON "notifications" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

-- Full-text retrieval over Company Brain chunks (tenant-scoped by RLS and explicit filters).
ALTER TABLE "knowledge_chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED;--> statement-breakpoint
CREATE INDEX "kc_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint

-- Append-only audit events and approval decisions. Deletion is only possible during an explicit
-- workspace offboarding purge, which sets app.audit_purge = 'on' inside its transaction.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER approval_decisions_append_only BEFORE UPDATE OR DELETE ON "approval_decisions" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER content_versions_append_only BEFORE UPDATE OR DELETE ON "content_versions" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
