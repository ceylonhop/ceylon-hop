import { pgTable, uuid, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  whatsapp: text('whatsapp').notNull(),
  country: text('country').notNull(),
  marketingOptIn: boolean('marketing_opt_in'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id),
  reference: text('reference').notNull().unique(),
  status: text('status').notNull(),
  mode: text('mode').notNull().default('single'),
  total: integer('total').notNull(),
  currency: text('currency').notNull(),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const transferRequests = pgTable('transfer_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .unique()
    .references(() => bookings.id),
  fromPlace: text('from_place').notNull(),
  toPlace: text('to_place').notNull(),
  travelDate: text('travel_date'),
  travelTime: text('travel_time'),
  vehicleType: text('vehicle_type').notNull(),
  adults: integer('adults').notNull(),
  children: integer('children').notNull(),
  bags: integer('bags').notNull(),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  provider: text('provider').notNull(),
  orderId: text('order_id').notNull().unique(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conciergeTasks = pgTable('concierge_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  type: text('type').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// v1 stores the multi-stop trip as arrays (stops/nights/dates) rather than the fully
// normalised itinerary/leg/stay of spec §5.2 — fine for the stub, normalise later.
export const tripRequests = pgTable('trip_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .unique()
    .references(() => bookings.id),
  serviceType: text('service_type').notNull(),
  pax: integer('pax').notNull(),
  vehicleType: text('vehicle_type').notNull(),
  stops: text('stops').array().notNull(),
  nights: integer('nights').array().notNull(),
  dates: text('dates').array(),
});
