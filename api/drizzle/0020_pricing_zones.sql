CREATE TABLE "pricing_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_name" text NOT NULL,
	"boost_pct" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"radius_km" double precision,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
