CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"product_id" text NOT NULL,
	"customer_email" text NOT NULL,
	"paypal_order_id" text,
	"capture_id" text,
	"subscription_id" text,
	"gross_minor" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"campaign" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"access_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"price_minor" bigint NOT NULL,
	"floor_minor" bigint NOT NULL,
	"paypal_product_id" text,
	"paypal_plan_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "orders_capture" ON "orders" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "orders_company" ON "orders" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "products_company" ON "products" USING btree ("company_id");