CREATE INDEX "idx_quotes_created_at" ON "quotes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_quotes_sent_at" ON "quotes" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "idx_quotes_decided_at" ON "quotes" USING btree ("decided_at");--> statement-breakpoint
CREATE INDEX "idx_quotes_live_status" ON "quotes" USING btree ("status") WHERE "quotes"."deleted_at" is null;