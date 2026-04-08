-- Run in Supabase SQL Editor (once).
-- 1) Products can appear under multiple shop categories (primary `category` + optional `extra_categories` JSON array).
-- 2) Discount coupons validated via RPC (anon cannot list all codes).

alter table public.products add column if not exists extra_categories jsonb default '[]'::jsonb;

create table if not exists public.store_coupons (
  code text primary key,
  kind text not null check (kind in ('percent', 'fixed')),
  amount numeric not null check (amount > 0),
  min_subtotal numeric not null default 0 check (min_subtotal >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.store_coupons enable row level security;

drop policy if exists "store_coupons_select_auth" on public.store_coupons;
create policy "store_coupons_select_auth" on public.store_coupons
  for select to authenticated using (true);

drop policy if exists "store_coupons_insert_auth" on public.store_coupons;
create policy "store_coupons_insert_auth" on public.store_coupons
  for insert to authenticated with check (true);

drop policy if exists "store_coupons_update_auth" on public.store_coupons;
create policy "store_coupons_update_auth" on public.store_coupons
  for update to authenticated using (true) with check (true);

drop policy if exists "store_coupons_delete_auth" on public.store_coupons;
create policy "store_coupons_delete_auth" on public.store_coupons
  for delete to authenticated using (true);

create or replace function public.validate_store_coupon(p_code text)
returns table (kind text, amount numeric, min_subtotal numeric)
language sql
security definer
set search_path = public
as $$
  select c.kind, c.amount, c.min_subtotal
  from public.store_coupons c
  where upper(trim(c.code)) = upper(trim(p_code))
    and c.active = true
  limit 1;
$$;

grant execute on function public.validate_store_coupon(text) to anon, authenticated;
