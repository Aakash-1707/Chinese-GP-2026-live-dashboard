create table if not exists public.instore_pickup_sales (
  id text primary key,
  product_id text not null,
  product_name text not null,
  qty integer not null check (qty > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null check (line_total >= 0),
  created_at timestamptz not null default now()
);

create index if not exists instore_pickup_sales_created_at_idx
  on public.instore_pickup_sales (created_at desc);
