-- Mercury Fleet MVP v1.1
-- Independent local drayage orders, task-scoped interactions, fleet profiles,
-- type-specific shipment milestones, and operator document review.

-- ---------------------------------------------------------------- identity
ALTER TABLE users ADD COLUMN username citext;
CREATE UNIQUE INDEX users_username_unique
  ON users (username) WHERE username IS NOT NULL;

-- ---------------------------------------------------------------- orders
CREATE TYPE order_type AS ENUM ('EXPORT_DRAYAGE','IMPORT_DRAYAGE');

ALTER TABLE orders
  ADD COLUMN order_type order_type,
  ADD COLUMN service_country char(2),
  ADD COLUMN requested_start_at timestamptz,
  ADD COLUMN requested_complete_at timestamptz,
  ADD COLUMN loading_location text,
  ADD COLUMN origin_terminal text,
  ADD COLUMN destination_terminal text,
  ADD COLUMN delivery_location text,
  ADD COLUMN empty_container_pickup_at timestamptz,
  ADD COLUMN terminal_cutoff_at timestamptz;

-- Preserve existing demo/dev data as import drayage.
UPDATE orders
   SET order_type='IMPORT_DRAYAGE',
       service_country='SG',
       requested_start_at=pickup_at,
       requested_complete_at=delivery_at,
       destination_terminal=pickup_location_text,
       delivery_location=delivery_location_text
 WHERE order_type IS NULL;

ALTER TABLE orders
  ALTER COLUMN order_type SET NOT NULL,
  ALTER COLUMN service_country SET NOT NULL,
  ALTER COLUMN requested_start_at SET NOT NULL;

ALTER TABLE orders ADD CONSTRAINT orders_v11_type_fields CHECK (
  (
    order_type='EXPORT_DRAYAGE'
    AND loading_location IS NOT NULL
    AND origin_terminal IS NOT NULL
    AND empty_container_pickup_location IS NOT NULL
    AND empty_container_pickup_at IS NOT NULL
  )
  OR
  (
    order_type='IMPORT_DRAYAGE'
    AND destination_terminal IS NOT NULL
    AND delivery_location IS NOT NULL
    AND empty_container_return_location IS NOT NULL
  )
) NOT VALID;

ALTER TABLE orders ADD CONSTRAINT orders_container_quantity_positive
  CHECK (container_quantity > 0) NOT VALID;

-- ---------------------------------------------------------------- bookings
ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'REVIEW_PENDING';

ALTER TABLE bookings
  ADD COLUMN confirmed_order_type order_type,
  ADD COLUMN container_type_snapshot text,
  ADD COLUMN container_quantity_snapshot integer,
  ADD COLUMN scheduled_start_at timestamptz;

UPDATE bookings b
   SET confirmed_order_type=o.order_type,
       container_type_snapshot=o.container_type,
       container_quantity_snapshot=o.container_quantity,
       scheduled_start_at=COALESCE(b.scheduled_pickup_at,o.requested_start_at)
  FROM orders o
 WHERE o.id=b.order_id;

-- ---------------------------------------------------------------- shipment milestones
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'WAITING_EMPTY_CONTAINER_RELEASE';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'EMPTY_CONTAINER_PICKED_UP';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'AT_LOADING_LOCATION';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'LOADED';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'EN_ROUTE_TO_TERMINAL';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'LADEN_CONTAINERS_RETURNED_TO_TERMINAL';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'WAITING_PORT_RELEASE';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'CONTAINER_PICKED_UP';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'IN_TRANSIT_TO_DELIVERY';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'EMPTY_RETURN_PENDING';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'EMPTY_RETURNED';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'DOCUMENTS_SUBMITTED';
ALTER TYPE shipment_status ADD VALUE IF NOT EXISTS 'REVIEW_PENDING';

-- ---------------------------------------------------------------- documents and review
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'EMPTY_CONTAINER_RELEASE';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'TERMINAL_HANDOVER';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'EMPTY_CONTAINER_RETURN';

CREATE TYPE document_review_status AS ENUM ('PENDING','APPROVED','REJECTED');
ALTER TABLE documents
  ADD COLUMN review_status document_review_status NOT NULL DEFAULT 'PENDING',
  ADD COLUMN reviewed_by_user_id uuid REFERENCES users(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text;

ALTER TYPE exception_type ADD VALUE IF NOT EXISTS 'DOCUMENT_REVIEW_REQUIRED';

-- ---------------------------------------------------------------- task-scoped pending interactions
CREATE TYPE pending_interaction_status AS ENUM ('ACTIVE','RESOLVED','EXPIRED','INVALIDATED');
CREATE TABLE pending_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  order_id uuid REFERENCES orders(id),
  rfq_recipient_id uuid REFERENCES rfq_recipients(id),
  booking_id uuid REFERENCES bookings(id),
  shipment_id uuid REFERENCES shipments(id),
  fleet_user_id uuid REFERENCES users(id),
  source_message_id uuid REFERENCES messages(id),
  interaction_type text NOT NULL,
  expected_order_version integer,
  expected_rfq_revision integer,
  expected_object_version integer,
  payload jsonb NOT NULL DEFAULT '{}',
  clarification_count integer NOT NULL DEFAULT 0,
  status pending_interaction_status NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT pending_interaction_has_task CHECK (
    order_id IS NOT NULL OR rfq_recipient_id IS NOT NULL
    OR booking_id IS NOT NULL OR shipment_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX one_active_pending_interaction_per_user_task
  ON pending_interactions (
    conversation_id,
    COALESCE(fleet_user_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(order_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(rfq_recipient_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(booking_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(shipment_id,'00000000-0000-0000-0000-000000000000'::uuid)
  ) WHERE status='ACTIVE';

CREATE TABLE task_read_states (
  rfq_recipient_id uuid NOT NULL REFERENCES rfq_recipients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rfq_recipient_id, user_id)
);

-- The old column remains readable during migration but is no longer written.
COMMENT ON COLUMN conversations.pending_intent IS
  'Deprecated by Mercury Fleet MVP v1.1; use pending_interactions.';
COMMENT ON COLUMN conversations.clarification_count IS
  'Deprecated by Mercury Fleet MVP v1.1; clarification state belongs to pending_interactions.';

-- ---------------------------------------------------------------- fleet profiles
CREATE TYPE fleet_profile_review_status AS ENUM ('DRAFT','PENDING_REVIEW','APPROVED','REJECTED');

CREATE TABLE fleet_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  accepting_orders boolean NOT NULL DEFAULT true,
  approved_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_profile_id uuid NOT NULL REFERENCES fleet_profiles(id),
  version integer NOT NULL,
  status fleet_profile_review_status NOT NULL DEFAULT 'DRAFT',
  fleet_name text NOT NULL,
  supports_hazardous boolean NOT NULL DEFAULT false,
  supports_reefer boolean NOT NULL DEFAULT false,
  contact_name text NOT NULL,
  contact_phone text NOT NULL,
  notes text,
  submitted_by_user_id uuid REFERENCES users(id),
  reviewed_by_user_id uuid REFERENCES users(id),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fleet_profile_id, version)
);

CREATE TABLE fleet_profile_version_countries (
  fleet_profile_version_id uuid NOT NULL REFERENCES fleet_profile_versions(id) ON DELETE CASCADE,
  country_code char(2) NOT NULL,
  PRIMARY KEY (fleet_profile_version_id, country_code)
);

ALTER TABLE fleet_profiles
  ADD CONSTRAINT fleet_profiles_approved_version_fk
  FOREIGN KEY (approved_version_id) REFERENCES fleet_profile_versions(id);

CREATE INDEX fleet_profile_versions_review_queue
  ON fleet_profile_versions (status, submitted_at)
  WHERE status='PENDING_REVIEW';
