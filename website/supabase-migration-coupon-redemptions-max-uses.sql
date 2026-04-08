-- Run in Supabase SQL Editor after supabase-migration-categories-coupons.sql
-- Limits how many times a coupon can be used (paid orders). NULL max_uses = unlimited.

alter table public.store_coupons add column if not exists max_uses int null
  check (max_uses is null or max_uses > 0);

create table if not exists public.coupon_redemptions (
  id bigint generated always as identity primary key,
  coupon_code text not null,
  order_id text not null references public.orders (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (order_id)
);

create index if not exists coupon_redemptions_code_upper_idx
  on public.coupon_redemptions (upper(trim(coupon_code)));

alter table public.coupon_redemptions enable row level security;

drop policy if exists "coupon_redemptions_select_auth" on public.coupon_redemptions;
create policy "coupon_redemptions_select_auth" on public.coupon_redemptions
  for select to authenticated using (true);

-- No insert/update/delete for anon — trigger runs as security definer.

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
    and (
      c.max_uses is null
      or (
        select count(*)::int
        from public.coupon_redemptions r
        where upper(trim(r.coupon_code)) = upper(trim(c.code))
      ) < c.max_uses
    )
  limit 1;
$$;

grant execute on function public.validate_store_coupon(text) to anon, authenticated;

create or replace function public.trg_orders_coupon_redemption()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cc text;
begin
  if tg_op = 'UPDATE'
     and new.status = 'Paid'
     and coalesce(old.status, '') is distinct from new.status
  then
    cc := nullif(trim(upper(new.customer->>'coupon_code')), '');
    if cc is not null and cc <> '' then
      insert into public.coupon_redemptions (coupon_code, order_id)
      values (cc, new.id)
      on conflict (order_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_coupon_redemption on public.orders;
create trigger orders_coupon_redemption
  after update on public.orders
  for each row
  execute procedure public.trg_orders_coupon_redemption();
