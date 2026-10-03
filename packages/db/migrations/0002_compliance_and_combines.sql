CREATE TABLE "compliance_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"shop_domain" text NOT NULL,
	"summary_json" text NOT NULL,
	"received_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
ALTER TABLE "compliance_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "combines_with_json" text;--> statement-breakpoint
CREATE INDEX "idx_compliance_shop" ON "compliance_requests" USING btree ("shop_domain","received_at");