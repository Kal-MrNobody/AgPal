CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" text,
	"summary" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"cost_entry_id" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"department" text NOT NULL,
	"title" text NOT NULL,
	"mandate" text NOT NULL,
	"model_tier" text NOT NULL,
	"heartbeat_cron" text NOT NULL,
	"envelope" text NOT NULL,
	"tools" jsonb NOT NULL,
	"reports_to" text DEFAULT 'founder' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"inbox_cursor" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_agent" ON "agent_runs" USING btree ("company_id","agent_id","started_at");--> statement-breakpoint
CREATE INDEX "agents_company" ON "agents" USING btree ("company_id");