-- Run once in Supabase SQL Editor if your project was created before variants / extra shipping.

alter table public.products add column if not exists variants jsonb default '[]'::jsonb;
alter table public.products add column if not exists extra_shipping_rs numeric default 0;

comment on column public.products.variants is 'JSON array: [{"label":"250 ml","price":299,"stockQty":5}, ...]. Omit stockQty to use product stock_qty for that option.';
comment on column public.products.extra_shipping_rs is 'Extra ₹ added to cart shipping per unit of this product (on top of weight-based shipping).';
