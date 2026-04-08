-- Run this in Supabase → SQL Editor → New query → Run once.
-- Then: Authentication → Users → Add user (your admin email + password).

create table if not exists public.products (
  id text primary key,
  name text not null,
  category text not null default 'Resin',
  price numeric not null,
  in_stock boolean not null default true,
  description text default '',
  image text,
  stock_qty int default 0,
  compare_at_price numeric,
  weight_kg numeric default 0.5,
  variants jsonb default '[]'::jsonb,
  extra_shipping_rs numeric default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id text primary key,
  customer jsonb not null,
  subtotal numeric not null,
  total numeric not null,
  payment_method text,
  payment_label text,
  status text not null default 'Pending',
  shipping_amount numeric default 0,
  total_weight_kg numeric,
  payment_reference text,
  created_at timestamptz not null default now()
);

-- If orders already existed without these columns, run once in SQL Editor:
-- alter table public.products add column if not exists weight_kg numeric default 0.5;
-- alter table public.products add column if not exists stock_qty int default 0;
-- alter table public.products add column if not exists compare_at_price numeric;
-- alter table public.orders add column if not exists shipping_amount numeric default 0;
-- alter table public.orders add column if not exists total_weight_kg numeric;
-- alter table public.orders add column if not exists payment_reference text;

-- Size/price options (JSON array) and optional extra shipping per unit (₹), run once if missing:
-- alter table public.products add column if not exists variants jsonb default '[]'::jsonb;
-- alter table public.products add column if not exists extra_shipping_rs numeric default 0;

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id text not null references public.orders (id) on delete cascade,
  product_id text,
  name text,
  price numeric,
  qty int not null default 1
);

create table if not exists public.contact_inquiries (
  id text primary key,
  name text,
  email text,
  phone text,
  message text,
  created_at timestamptz not null default now()
);

create table if not exists public.product_categories (
  name text primary key,
  image_url text,
  created_at timestamptz not null default now()
);

alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.contact_inquiries enable row level security;
alter table public.product_categories enable row level security;

-- Anyone can read the catalog
drop policy if exists "products_select_anon" on public.products;
create policy "products_select_anon" on public.products for select using (true);

-- Signed-in admin: insert / update / delete products (split policies; FOR ALL can break INSERT on some setups)
drop policy if exists "products_write_auth" on public.products;
drop policy if exists "products_insert_auth" on public.products;
drop policy if exists "products_update_auth" on public.products;
drop policy if exists "products_delete_auth" on public.products;
create policy "products_insert_auth" on public.products
  for insert to authenticated with check (true);
create policy "products_update_auth" on public.products
  for update to authenticated using (true) with check (true);
create policy "products_delete_auth" on public.products
  for delete to authenticated using (true);

-- Anyone can place an order (insert only)
drop policy if exists "orders_insert_anon" on public.orders;
create policy "orders_insert_anon" on public.orders for insert with check (true);

drop policy if exists "orders_select_auth" on public.orders;
create policy "orders_select_auth" on public.orders for select using (auth.role() = 'authenticated');

drop policy if exists "orders_update_auth" on public.orders;
create policy "orders_update_auth" on public.orders for update using (auth.role() = 'authenticated');

drop policy if exists "order_items_insert_anon" on public.order_items;
create policy "order_items_insert_anon" on public.order_items for insert with check (true);

drop policy if exists "order_items_select_auth" on public.order_items;
create policy "order_items_select_auth" on public.order_items for select using (auth.role() = 'authenticated');

-- Contact form: public insert, admin read
drop policy if exists "contact_insert_anon" on public.contact_inquiries;
create policy "contact_insert_anon" on public.contact_inquiries for insert with check (true);

drop policy if exists "contact_select_auth" on public.contact_inquiries;
create policy "contact_select_auth" on public.contact_inquiries for select using (auth.role() = 'authenticated');

-- Categories: anyone can read, authenticated can insert/update/delete
drop policy if exists "product_categories_select_anon" on public.product_categories;
create policy "product_categories_select_anon" on public.product_categories
  for select using (true);

drop policy if exists "product_categories_insert_auth" on public.product_categories;
drop policy if exists "product_categories_update_auth" on public.product_categories;
drop policy if exists "product_categories_delete_auth" on public.product_categories;

create policy "product_categories_insert_auth" on public.product_categories
  for insert to authenticated with check (true);

create policy "product_categories_update_auth" on public.product_categories
  for update to authenticated using (true) with check (true);

create policy "product_categories_delete_auth" on public.product_categories
  for delete to authenticated using (true);

-- Storage (run in SQL if using product image upload to Supabase Storage):
-- insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
-- on conflict (id) do nothing;
-- create policy "product_images_public_read" on storage.objects for select using (bucket_id = 'product-images');
-- create policy "product_images_auth_upload" on storage.objects for insert to authenticated with check (bucket_id = 'product-images');
-- create policy "product_images_auth_update" on storage.objects for update to authenticated using (bucket_id = 'product-images') with check (bucket_id = 'product-images');
-- create policy "product_images_auth_delete" on storage.objects for delete to authenticated using (bucket_id = 'product-images');

-- Seed sample products (skip if you already have rows)
insert into public.products (id, name, category, price, in_stock, description, image)
values
  ('1', 'Crystal Clear Epoxy Resin (500g)', 'Resin', 450, true,
   'Low-odor, crystal clear epoxy resin ideal for casting, coating, and river tables.', null),
  ('2', 'Silicone Mold Set — Geometric Shapes', 'Molds', 320, true,
   'Flexible silicone molds for coasters, pendants, and geometric resin art.', null),
  ('3', 'Resin Pigment Powder Set (12 colors)', 'Pigments', 280, true,
   'Vibrant mica-based pigment powders for resin coloring.', null),
  ('4', 'UV Resin (100ml)', 'Resin', 380, false,
   'Fast-curing UV resin for jewelry and small projects.', null),
  ('5', 'Resin Mixing Tools Kit', 'Tools', 150, true,
   'Sticks, cups, and gloves for clean, precise resin mixing.', null),
  ('6', 'Glitter Flakes Assorted Pack', 'Accessories', 120, true,
   'Assorted cosmetic-grade glitter flakes to add sparkle to your pours.', null)
on conflict (id) do nothing;

-- Seed categories from existing products (so the home/shop category tiles work immediately)
insert into public.product_categories (name)
select distinct category
from public.products
where category is not null and trim(category) <> ''
on conflict (name) do nothing;
