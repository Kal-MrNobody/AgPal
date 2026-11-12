CREATE TABLE "schedule_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"from_task" text NOT NULL,
	"to_task" text NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"duration_days" integer DEFAULT 0 NOT NULL,
	"constraint_date" timestamp with time zone,
	"percent_done" integer DEFAULT 0 NOT NULL,
	"ref" text,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"confirmed" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "schedule_deps_company" ON "schedule_dependencies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "schedule_tasks_company" ON "schedule_tasks" USING btree ("company_id");