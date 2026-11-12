CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"department" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"missing_in_ledger" integer DEFAULT 0 NOT NULL,
	"missing_in_paypal" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"amount_mismatches" integer DEFAULT 0 NOT NULL,
	"suspense_items" integer DEFAULT 0 NOT NULL,
	"balance_diff_minor" bigint,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"payload" jsonb NOT NULL,
	"verified" boolean NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "alerts_open" ON "alerts" USING btree ("company_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_dedupe" ON "domain_events" USING btree ("company_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "domain_events_name" ON "domain_events" USING btree ("company_id","name","created_at");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_company" ON "reconciliation_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_status" ON "webhook_events" USING btree ("status","received_at");