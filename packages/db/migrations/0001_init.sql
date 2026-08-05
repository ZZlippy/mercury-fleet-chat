-- Mercury Fleet Chat MVP — initial schema (spec §6–§9, §13)
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- §6.1 organizations
CREATE TYPE organization_type AS ENUM ('MERCURY','CUSTOMER','FLEET');
CREATE TYPE organization_status AS ENUM ('ACTIVE','SUSPENDED');
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type organization_type NOT NULL,
  name text NOT NULL,
  status organization_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- §6.2 users, memberships
CREATE TYPE user_status AS ENUM ('ACTIVE','SUSPENDED');
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE,
  phone_e164 text UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE membership_role AS ENUM ('FLEET_ADMIN','DISPATCHER','VIEWER','OPERATOR');
CREATE TYPE membership_status AS ENUM ('ACTIVE','INVITED','DISABLED');
CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role membership_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §7.1 orders
CREATE TYPE order_status AS ENUM ('DRAFT','QUOTING','BOOKED','IN_PROGRESS','COMPLETED','CANCELLED');
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_reference text NOT NULL UNIQUE,
  customer_organization_id uuid NOT NULL REFERENCES organizations(id),
  status order_status NOT NULL DEFAULT 'DRAFT',
  pickup_location_text text NOT NULL,
  delivery_location_text text NOT NULL,
  container_type text NOT NULL,
  container_quantity integer NOT NULL,
  pickup_at timestamptz NOT NULL,
  delivery_at timestamptz,
  special_requirements text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- §7.2 rfqs (exactly one per order)
CREATE TYPE rfq_status AS ENUM ('CREATED','ACTIVE','CLOSED','CANCELLED');
CREATE TABLE rfqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  public_reference text NOT NULL UNIQUE,
  status rfq_status NOT NULL DEFAULT 'CREATED',
  revision integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- §7.3 rfq_recipients
CREATE TYPE rfq_recipient_status AS ENUM (
  'PENDING','SENT','VIEWED','AWAITING_QUOTE','AWAITING_RECONFIRMATION',
  'QUOTED','DECLINED','EXPIRED','WITHDRAWN'
);
CREATE TABLE rfq_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES rfqs(id),
  fleet_organization_id uuid NOT NULL REFERENCES organizations(id),
  status rfq_recipient_status NOT NULL DEFAULT 'PENDING',
  notified_revision integer,
  acknowledged_revision integer,
  sent_at timestamptz,
  viewed_at timestamptz,
  responded_at timestamptz,
  last_reminded_at timestamptz,
  reminder_count integer NOT NULL DEFAULT 0,
  decline_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, fleet_organization_id)
);

-- §7.4 quotes
CREATE TYPE quote_status AS ENUM (
  'DRAFT','PENDING_CONFIRMATION','SUBMITTED','INVALIDATED',
  'ACCEPTED','REJECTED','WITHDRAWN','EXPIRED'
);
CREATE TYPE currency_source AS ENUM ('EXPLICIT','DEFAULTED','INHERITED');
CREATE TYPE quote_invalidated_reason AS ENUM ('ORDER_CHANGED','RFQ_CANCELLED','OPERATOR_ACTION');
CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_recipient_id uuid NOT NULL REFERENCES rfq_recipients(id),
  based_on_order_version integer NOT NULL,
  based_on_rfq_revision integer NOT NULL,
  status quote_status NOT NULL DEFAULT 'DRAFT',
  amount numeric(18,2) NOT NULL,
  currency char(3) NOT NULL,
  currency_source currency_source NOT NULL,
  currency_confirmed_at timestamptz,
  is_all_in boolean,
  vehicle_available boolean,
  available_from timestamptz,
  valid_until timestamptz,
  terms text,
  source_message_id uuid,
  submitted_at timestamptz,
  invalidated_at timestamptz,
  invalidated_reason quote_invalidated_reason,
  supersedes_quote_id uuid REFERENCES quotes(id),
  superseded_by_quote_id uuid REFERENCES quotes(id),
  created_by_user_id uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- §7.4: at most one usable (active) quote per recipient/revision
CREATE UNIQUE INDEX one_active_quote_per_recipient_revision
  ON quotes (rfq_recipient_id, based_on_rfq_revision)
  WHERE status IN ('PENDING_CONFIRMATION','SUBMITTED');

-- §7.5 bookings
CREATE TYPE booking_status AS ENUM (
  'OFFERED','ACCEPTED','RESOURCE_PENDING','READY','IN_PROGRESS','COMPLETED',
  'CANCELLED_BY_FLEET','CANCELLED_BY_CUSTOMER','CANCELLED_BY_OPERATOR'
);
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_reference text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id),
  selected_quote_id uuid REFERENCES quotes(id),
  fleet_organization_id uuid NOT NULL REFERENCES organizations(id),
  status booking_status NOT NULL DEFAULT 'OFFERED',
  confirmed_amount numeric(18,2) NOT NULL,
  confirmed_currency char(3) NOT NULL,
  confirmed_terms text,
  confirmed_order_version integer NOT NULL,
  scheduled_pickup_at timestamptz,
  offered_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- §7.5: at most one non-cancelled active booking per order
CREATE UNIQUE INDEX one_active_booking_per_order
  ON bookings (order_id)
  WHERE status NOT IN ('CANCELLED_BY_FLEET','CANCELLED_BY_CUSTOMER','CANCELLED_BY_OPERATOR');

-- §7.6 drivers, vehicles, assignments
CREATE TYPE resource_status AS ENUM ('ACTIVE','INACTIVE');
CREATE TABLE drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  phone_e164 text,
  license_reference text,
  status resource_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_organization_id uuid NOT NULL REFERENCES organizations(id),
  plate_number text NOT NULL,
  vehicle_type text,
  status resource_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fleet_organization_id, plate_number)
);
CREATE TABLE booking_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id)
);
-- one active assignment per booking (MVP)
CREATE UNIQUE INDEX one_active_assignment_per_booking
  ON booking_assignments (booking_id) WHERE unassigned_at IS NULL;

-- §7.7 shipments and events
CREATE TYPE shipment_status AS ENUM (
  'WAITING_ASSIGNMENT','DRIVER_ASSIGNED','EN_ROUTE_TO_PICKUP','AT_PICKUP','PICKED_UP',
  'IN_TRANSIT','AT_DELIVERY','DELIVERED','POD_SUBMITTED','COMPLETED','EXCEPTION'
);
CREATE TYPE event_source AS ENUM ('WEB','WHATSAPP','WECHAT','API','OPERATOR','SYSTEM');
CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  current_status shipment_status NOT NULL DEFAULT 'WAITING_ASSIGNMENT',
  estimated_arrival_at timestamptz,
  actual_pickup_at timestamptz,
  actual_delivery_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  event_type text NOT NULL,
  from_status text,
  to_status text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  reported_by_user_id uuid REFERENCES users(id),
  source event_source NOT NULL,
  source_message_id uuid,
  location_text text,
  notes text,
  payload jsonb NOT NULL DEFAULT '{}',
  idempotency_key text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §7.8 documents
CREATE TYPE document_type AS ENUM ('DO','BOOKING_CONFIRMATION','POD','IMAGE','OTHER');
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  type document_type NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL UNIQUE,
  checksum_sha256 text,
  uploaded_by_user_id uuid REFERENCES users(id),
  source_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  order_id uuid REFERENCES orders(id),
  booking_id uuid REFERENCES bookings(id),
  shipment_id uuid REFERENCES shipments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_link_has_target CHECK (
    order_id IS NOT NULL OR booking_id IS NOT NULL OR shipment_id IS NOT NULL
  )
);

-- §8.1 conversations
CREATE TYPE channel AS ENUM ('WEB','WHATSAPP','WECHAT');
CREATE TYPE conversation_status AS ENUM ('ACTIVE','ARCHIVED');
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_organization_id uuid NOT NULL REFERENCES organizations(id),
  channel channel NOT NULL,
  external_thread_key text,
  status conversation_status NOT NULL DEFAULT 'ACTIVE',
  -- MVP pragmatic addition: conversation-scoped pending intent for multi-turn
  -- flows (modify-quote, currency clarification, resource assignment).
  -- Business objects remain the source of truth; this only steers dialogue.
  pending_intent jsonb,
  clarification_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_web_conversation_per_fleet
  ON conversations (fleet_organization_id, channel) WHERE status = 'ACTIVE';

-- §8.2 messages
CREATE TYPE message_direction AS ENUM ('INBOUND','OUTBOUND');
CREATE TYPE sender_type AS ENUM ('FLEET_USER','MERCURY_AI','MERCURY_SYSTEM','OPERATOR');
CREATE TYPE message_type AS ENUM ('TEXT','BUSINESS_CARD','ACTION_PROMPT','FILE','SYSTEM_NOTICE','HANDOFF_NOTICE');
CREATE TYPE delivery_status AS ENUM ('PENDING','SENT','DELIVERED','READ','FAILED');
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  direction message_direction NOT NULL,
  sender_type sender_type NOT NULL,
  sender_user_id uuid REFERENCES users(id),
  message_type message_type NOT NULL,
  text_content text,
  structured_content jsonb NOT NULL DEFAULT '{}',
  external_message_id text,
  external_created_at timestamptz,
  reply_to_message_id uuid REFERENCES messages(id),
  in_reply_to_external_message_id text,
  delivery_status delivery_status NOT NULL DEFAULT 'PENDING',
  raw_channel_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_external_dedupe
  ON messages (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX messages_conversation_created ON messages (conversation_id, created_at);

-- §8.3 message context links
CREATE TABLE message_context_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id),
  order_id uuid REFERENCES orders(id),
  rfq_id uuid REFERENCES rfqs(id),
  rfq_recipient_id uuid REFERENCES rfq_recipients(id),
  quote_id uuid REFERENCES quotes(id),
  booking_id uuid REFERENCES bookings(id),
  shipment_id uuid REFERENCES shipments(id),
  -- correlation: which RFQ revision the linked message was rendered for
  rfq_revision integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcl_message ON message_context_links (message_id);

-- §8.4 message actions
CREATE TYPE action_type AS ENUM (
  'ACK_PRICE_UNCHANGED','MODIFY_QUOTE','DECLINE_RFQ','ACK_REPLY_LATER',
  'CONFIRM_QUOTE','CANCEL_QUOTE_DRAFT','ACCEPT_BOOKING','DECLINE_BOOKING',
  'CONFIRM_ASSIGNMENT','CONFIRM_SHIPMENT_STATUS','REQUEST_HUMAN','SELECT_RFQ_CONTEXT'
);
CREATE TYPE action_status AS ENUM ('AVAILABLE','CONSUMED','EXPIRED','INVALIDATED');
CREATE TABLE message_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id),
  action_type action_type NOT NULL,
  label text NOT NULL,
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  expected_order_version integer,
  expected_rfq_revision integer,
  expected_object_version integer,
  payload jsonb NOT NULL DEFAULT '{}',
  status action_status NOT NULL DEFAULT 'AVAILABLE',
  expires_at timestamptz,
  consumed_at timestamptz,
  consumed_by_user_id uuid REFERENCES users(id),
  idempotency_key text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_actions_message ON message_actions (message_id);

-- §9.1 audit logs
CREATE TYPE actor_type AS ENUM ('USER','AGENT','OPERATOR','SYSTEM');
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type actor_type NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  action text NOT NULL,
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  source_message_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_object ON audit_logs (object_type, object_id);

-- §9.2 command idempotency
CREATE TABLE processed_commands (
  idempotency_key text PRIMARY KEY,
  command_type text NOT NULL,
  result_reference jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- §9.3 transactional outbox
CREATE TYPE outbox_status AS ENUM ('PENDING','PROCESSING','SENT','FAILED');
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status outbox_status NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events (status, available_at);

-- §13 exception cases
CREATE TYPE exception_type AS ENUM (
  'AMBIGUOUS_CONTEXT','AMBIGUOUS_CURRENCY','LOW_CONFIDENCE','STALE_MESSAGE',
  'NO_FLEET_RESPONSE','ORDER_CHANGED_AFTER_BOOKING','FLEET_CANCELLED',
  'INVALID_STATE_TRANSITION','POD_REVIEW_REQUIRED','DELIVERY_FAILURE','OTHER'
);
CREATE TYPE exception_status AS ENUM ('OPEN','IN_PROGRESS','RESOLVED','DISMISSED');
CREATE TABLE exception_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type exception_type NOT NULL,
  status exception_status NOT NULL DEFAULT 'OPEN',
  order_id uuid REFERENCES orders(id),
  rfq_id uuid REFERENCES rfqs(id),
  fleet_organization_id uuid REFERENCES organizations(id),
  conversation_id uuid REFERENCES conversations(id),
  source_message_id uuid,
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  assigned_operator_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
