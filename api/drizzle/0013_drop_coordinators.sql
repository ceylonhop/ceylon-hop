ALTER TABLE "ride_ops" DROP CONSTRAINT "ride_ops_coordinator_id_coordinators_id_fk";--> statement-breakpoint
ALTER TABLE "ride_ops" DROP COLUMN "coordinator_id";--> statement-breakpoint
ALTER TABLE "coordinators" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "coordinators";
