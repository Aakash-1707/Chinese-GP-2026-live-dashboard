-- Run once in Supabase SQL Editor if order line items should store the chosen size separately
-- (the app also encodes size in `name`; this column enables cleaner stock alerts and reporting).

alter table public.order_items add column if not exists variant_label text;
