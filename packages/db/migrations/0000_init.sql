CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"public_key" text,
	"api_key_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"role" text DEFAULT 'shopper' NOT NULL,
	"rate_per_minute" integer,
	"rate_per_day" integer,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_agent_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" text NOT NULL,
	"allow_json" text NOT NULL,
	"caps_json" text NOT NULL,
	"selector_json" text NOT NULL,
	"card_text" text NOT NULL,
	"human_confirmed_at" text,
	"revoked_at" text,
	"superseded_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mandates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"shop_domain" text NOT NULL,
	"shopify_shop_id" text,
	"access_token_enc" text,
	"name" text NOT NULL,
	"website" text,
	"catalog_json" text,
	"created_at" text NOT NULL,
	CONSTRAINT "merchants_shop_domain_unique" UNIQUE("shop_domain")
);
--> statement-breakpoint
ALTER TABLE "merchants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "offers" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"status" text NOT NULL,
	"selector_type" text NOT NULL,
	"selector_ids_json" text NOT NULL,
	"selector_title" text,
	"list_price" text,
	"selector_currency" text,
	"reward_type" text NOT NULL,
	"reward_amount" text NOT NULL,
	"reward_currency" text NOT NULL,
	"reward_recipient" text DEFAULT 'buyer' NOT NULL,
	"finder_fee_type" text,
	"finder_fee_amount" text,
	"finder_fee_currency" text,
	"finder_fee_recipient" text,
	"new_customer_only" integer DEFAULT 0 NOT NULL,
	"ship_to_json" text,
	"max_per_principal_per_day" integer,
	"max_units_per_order" integer,
	"clawback_days" integer DEFAULT 14 NOT NULL,
	"disclosure" text NOT NULL,
	"checkout_url_template" text NOT NULL,
	"ucp" integer DEFAULT 0 NOT NULL,
	"mandate_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_ext_id" text NOT NULL,
	"shopify_refund_id" text NOT NULL,
	"amount" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders_ext" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"shopify_order_id" text,
	"token_id" text NOT NULL,
	"total" text NOT NULL,
	"order_total" text,
	"attributed_lines_json" text,
	"refunded_total" text DEFAULT '0.00' NOT NULL,
	"currency" text NOT NULL,
	"email_hash" text,
	"status" text NOT NULL,
	"paid_at" text NOT NULL,
	"hold_until" text NOT NULL,
	"clawed_at" text
);
--> statement-breakpoint
ALTER TABLE "orders_ext" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_ext_id" text NOT NULL,
	"party" text NOT NULL,
	"agent_id" text,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"email_hash" text NOT NULL,
	"shopify_customer_id" text,
	"first_seen_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "seller_links" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_agent_id" text NOT NULL,
	"shop_domain" text,
	"status" text NOT NULL,
	"install_url" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" text NOT NULL,
	"merchant_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seller_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shop_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"seller_agent_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shop_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tokens" (
	"token_id" text PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"principal_hash" text NOT NULL,
	"referrer_agent_id" text,
	"exp" bigint NOT NULL,
	"nonce" text NOT NULL,
	"raw_jws" text NOT NULL,
	"consumed_at" text,
	"issued_by" text,
	"discount_code" text,
	"discount_node_id" text,
	"discount_deleted_at" text,
	"discount_cleanup_error" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"shop_domain" text,
	"result_json" text NOT NULL,
	"received_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_order_ext_id_orders_ext_id_fk" FOREIGN KEY ("order_ext_id") REFERENCES "public"."orders_ext"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders_ext" ADD CONSTRAINT "orders_ext_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders_ext" ADD CONSTRAINT "orders_ext_token_id_tokens_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("token_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_order_ext_id_orders_ext_id_fk" FOREIGN KEY ("order_ext_id") REFERENCES "public"."orders_ext"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_links" ADD CONSTRAINT "seller_links_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_links" ADD CONSTRAINT "seller_links_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_grants" ADD CONSTRAINT "shop_grants_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_grants" ADD CONSTRAINT "shop_grants_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agents_api_key_hash" ON "agents" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "idx_mandates_seller_merchant" ON "mandates" USING btree ("seller_agent_id","merchant_id","status");--> statement-breakpoint
CREATE INDEX "idx_offers_merchant_status" ON "offers" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "idx_offers_status" ON "offers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_offers_mandate" ON "offers" USING btree ("mandate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_order_refunds_unique" ON "order_refunds" USING btree ("order_ext_id","shopify_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_orders_shopify" ON "orders_ext" USING btree ("shopify_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_orders_token" ON "orders_ext" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "idx_orders_merchant_paid" ON "orders_ext" USING btree ("merchant_id","paid_at");--> statement-breakpoint
CREATE INDEX "idx_orders_email" ON "orders_ext" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "idx_payouts_order" ON "payouts" USING btree ("order_ext_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_principals_merchant_email" ON "principals" USING btree ("merchant_id","email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_shop_grants_unique" ON "shop_grants" USING btree ("merchant_id","seller_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tokens_nonce" ON "tokens" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tokens_raw" ON "tokens" USING btree ("raw_jws");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tokens_discount_node" ON "tokens" USING btree ("discount_node_id");--> statement-breakpoint
CREATE INDEX "idx_tokens_issued_by" ON "tokens" USING btree ("issued_by","created_at");--> statement-breakpoint
CREATE INDEX "idx_tokens_offer_created" ON "tokens" USING btree ("offer_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tokens_principal" ON "tokens" USING btree ("principal_hash");--> statement-breakpoint
CREATE INDEX "idx_tokens_open_discounts" ON "tokens" USING btree ("exp") WHERE discount_node_id IS NOT NULL AND discount_deleted_at IS NULL AND consumed_at IS NULL;