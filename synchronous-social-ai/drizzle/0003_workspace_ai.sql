CREATE TABLE "workspace_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"hint" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD CONSTRAINT "workspace_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD CONSTRAINT "workspace_secrets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_secret_uq" ON "workspace_secrets" USING btree ("workspace_id","key");--> statement-breakpoint
ALTER TABLE "workspace_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_secrets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_secrets_tenant_isolation" ON "workspace_secrets" USING (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
