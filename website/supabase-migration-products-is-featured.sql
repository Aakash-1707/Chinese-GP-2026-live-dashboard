-- Run once in Supabase SQL Editor: home page "Featured" picks (max 10 enforced in admin UI).
alter table public.products add column if not exists is_featured boolean not null default false;

create index if not exists products_is_featured_idx on public.products (is_featured) where is_featured = true;
