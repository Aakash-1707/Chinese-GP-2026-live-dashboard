-- Run in Supabase SQL Editor after supabase-migration-coupon-redemptions-max-uses.sql
-- Adds optional max discount cap (₹) and product IDs the coupon must NOT apply to.

alter table public.store_coupons add column if not exists max_discount_rs numeric null
  check (max_discount_rs is null or max_discount_rs > 0);

alter table public.store_coupons add column if not exists excluded_product_ids text[] not null default '{}'::text[];

-- Return type changed — drop and recreate.
drop function if exists public.validate_store_coupon(text);

create function public.validate_store_coupon(p_code text)
returns table (
  kind text,
  amount numeric,
  min_subtotal numeric,
  max_discount_rs numeric,
  excluded_product_ids text[]
)
language sql
security definer
set search_path = public
as $$
  select
    c.kind,
    c.amount,
    c.min_subtotal,
    c.max_discount_rs,
    coalesce(c.excluded_product_ids, '{}'::text[])
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
