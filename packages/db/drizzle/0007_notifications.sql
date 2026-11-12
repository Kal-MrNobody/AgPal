CREATE TABLE "approval_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"channel" text NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_callbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"approval_id" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_notifications_once" ON "approval_notifications" USING btree ("approval_id","channel");