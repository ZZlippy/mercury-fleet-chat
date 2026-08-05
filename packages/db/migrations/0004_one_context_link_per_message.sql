-- One context link per message.
--
-- Why: a message belongs to exactly one task. Two paths used to write links for
-- the same inbound message (recordInbound copying the parent's link, and the
-- delayed/stale-reply branch adding its own), producing duplicate rows. Context
-- resolution reads a single row, so duplicates made the resolved task and RFQ
-- revision depend on physical row order — which is exactly the logic that has
-- to route delayed WhatsApp/WeChat replies to the right task and revision.
--
-- Existing data is preserved: duplicates are merged field-by-field, keeping the
-- earliest non-null value for each column so original revision linkage survives.

-- 1. Merge duplicates into the earliest row for each message.
WITH ranked AS (
  SELECT id, message_id, created_at,
         row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
    FROM message_context_links
),
keep AS (SELECT id, message_id FROM ranked WHERE rn = 1),
merged AS (
  SELECT k.id AS keep_id,
         (array_agg(l.order_id         ORDER BY l.created_at, l.id) FILTER (WHERE l.order_id         IS NOT NULL))[1] AS order_id,
         (array_agg(l.rfq_id           ORDER BY l.created_at, l.id) FILTER (WHERE l.rfq_id           IS NOT NULL))[1] AS rfq_id,
         (array_agg(l.rfq_recipient_id ORDER BY l.created_at, l.id) FILTER (WHERE l.rfq_recipient_id IS NOT NULL))[1] AS rfq_recipient_id,
         (array_agg(l.quote_id         ORDER BY l.created_at, l.id) FILTER (WHERE l.quote_id         IS NOT NULL))[1] AS quote_id,
         (array_agg(l.booking_id       ORDER BY l.created_at, l.id) FILTER (WHERE l.booking_id       IS NOT NULL))[1] AS booking_id,
         (array_agg(l.shipment_id      ORDER BY l.created_at, l.id) FILTER (WHERE l.shipment_id      IS NOT NULL))[1] AS shipment_id,
         (array_agg(l.rfq_revision     ORDER BY l.created_at, l.id) FILTER (WHERE l.rfq_revision     IS NOT NULL))[1] AS rfq_revision
    FROM keep k
    JOIN message_context_links l ON l.message_id = k.message_id
   GROUP BY k.id
)
UPDATE message_context_links t
   SET order_id         = m.order_id,
       rfq_id           = m.rfq_id,
       rfq_recipient_id = m.rfq_recipient_id,
       quote_id         = m.quote_id,
       booking_id       = m.booking_id,
       shipment_id      = m.shipment_id,
       rfq_revision     = m.rfq_revision
  FROM merged m
 WHERE t.id = m.keep_id;

-- 2. Drop the now-redundant duplicate rows.
DELETE FROM message_context_links l
 USING (
   SELECT id, row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
     FROM message_context_links
 ) d
 WHERE l.id = d.id AND d.rn > 1;

-- 3. Enforce the invariant from here on. This is also the conflict target that
--    lets link writes be idempotent instead of additive.
CREATE UNIQUE INDEX IF NOT EXISTS message_context_links_one_per_message
  ON message_context_links (message_id);
