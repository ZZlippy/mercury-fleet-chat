-- Richer container-trucking order details. Existing rows remain valid because
-- the new operational/reference fields are nullable.
ALTER TABLE orders
  ADD COLUMN customer_reference text,
  ADD COLUMN carrier_booking_reference text,
  ADD COLUMN bill_of_lading_reference text,
  ADD COLUMN shipping_line text,
  ADD COLUMN vessel_name text,
  ADD COLUMN voyage_number text,
  ADD COLUMN pickup_contact_name text,
  ADD COLUMN pickup_contact_phone text,
  ADD COLUMN delivery_contact_name text,
  ADD COLUMN delivery_contact_phone text,
  ADD COLUMN empty_container_pickup_location text,
  ADD COLUMN empty_container_return_location text,
  ADD COLUMN empty_container_return_deadline timestamptz,
  ADD COLUMN container_number text,
  ADD COLUMN seal_number text,
  ADD COLUMN cargo_description text,
  ADD COLUMN gross_weight_kg numeric(12,2),
  ADD COLUMN is_hazardous boolean NOT NULL DEFAULT false,
  ADD COLUMN un_number text,
  ADD COLUMN is_reefer boolean NOT NULL DEFAULT false,
  ADD COLUMN reefer_temperature_c numeric(6,2);

CREATE INDEX orders_customer_reference_idx ON orders (customer_reference)
  WHERE customer_reference IS NOT NULL;
CREATE INDEX orders_container_number_idx ON orders (container_number)
  WHERE container_number IS NOT NULL;
