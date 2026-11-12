CREATE TABLE "internal_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"task_id" text,
	"seller_department" text NOT NULL,
	"buyer_department" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"intent_id" text,
	"dispute_reason" text,
	"issued_by_run" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"task_id" text,
	"from_party" text NOT NULL,
	"to_department" text NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"untrusted" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"from_department" text NOT NULL,
	"to_department" text NOT NULL,
	"contractor_email" text,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"budget_minor" bigint NOT NULL,
	"deadline" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"campaign" text,
	"created_by_agent" text,
	"created_by_run" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "internal_invoices_buyer" ON "internal_invoices" USING btree ("company_id","buyer_department","status");--> statement-breakpoint
CREATE INDEX "messages_inbox" ON "messages" USING btree ("company_id","to_department","read_at");--> statement-breakpoint
CREATE INDEX "tasks_to" ON "tasks" USING btree ("company_id","to_department","status");