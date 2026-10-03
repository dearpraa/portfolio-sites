create table if not exists public.media (
  id text primary key,
  file_name text not null,
  file_url text not null unique,
  mime_type text not null,
  alt_text text not null default '',
  created_at timestamptz not null default now(),
  ai_metadata text
);

create table if not exists public.sections (
  id text primary key,
  name text not null,
  title text not null,
  description text not null default '',
  slug text not null unique,
  is_visible smallint not null default 1 check (is_visible in (0, 1)),
  display_order integer not null default 0,
  is_system smallint not null default 0 check (is_system in (0, 1))
);

create table if not exists public.portfolio_items (
  id text primary key,
  media_id text not null references public.media(id) on delete restrict,
  title text not null,
  description text not null default '',
  category text not null default '',
  location text not null default '',
  photo_date text not null default '',
  tags text not null default '',
  is_featured smallint not null default 0 check (is_featured in (0, 1)),
  is_published smallint not null default 0 check (is_published in (0, 1)),
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_hidden smallint not null default 0 check (is_hidden in (0, 1))
);

create table if not exists public.portfolio_item_sections (
  portfolio_item_id text not null references public.portfolio_items(id) on delete cascade,
  section_id text not null references public.sections(id) on delete cascade,
  primary key (portfolio_item_id, section_id)
);

create table if not exists public.social_links (
  id text primary key,
  platform text not null,
  display_name text not null,
  url text not null,
  icon text not null,
  is_visible smallint not null default 1 check (is_visible in (0, 1)),
  display_order integer not null default 0
);

create table if not exists public.social_link_locations (
  social_link_id text not null references public.social_links(id) on delete cascade,
  location text not null,
  display_order integer not null default 0,
  primary key (social_link_id, location)
);

create table if not exists public.site_content (
  content_key text primary key,
  content_value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.navigation_items (
  id text primary key,
  label text not null,
  url text not null,
  icon text not null default '',
  is_visible smallint not null default 1 check (is_visible in (0, 1)),
  display_order integer not null default 0
);

create table if not exists public.skills (
  id text primary key,
  name text not null,
  percent integer not null default 80 check (percent between 0 and 100),
  icon text not null default 'ri-star-line',
  display_order integer not null default 0,
  is_visible smallint not null default 1 check (is_visible in (0, 1))
);

create index if not exists portfolio_published_order
  on public.portfolio_items (is_published, display_order);
create index if not exists portfolio_sections_section
  on public.portfolio_item_sections (section_id);
create index if not exists social_locations
  on public.social_link_locations (location);

alter table public.media enable row level security;
alter table public.sections enable row level security;
alter table public.portfolio_items enable row level security;
alter table public.portfolio_item_sections enable row level security;
alter table public.social_links enable row level security;
alter table public.social_link_locations enable row level security;
alter table public.site_content enable row level security;
alter table public.navigation_items enable row level security;
alter table public.skills enable row level security;

grant select, insert, update, delete on
  public.media,
  public.sections,
  public.portfolio_items,
  public.portfolio_item_sections,
  public.social_links,
  public.social_link_locations,
  public.site_content,
  public.navigation_items,
  public.skills
to service_role;

insert into public.sections (id, name, title, description, slug, display_order, is_system)
values
  ('home', 'Homepage', 'Homepage', '', 'homepage', 0, 1),
  ('portfolio', 'Portfolio', 'Portfolio', '', 'portfolio', 1, 1),
  ('gallery', 'Gallery', 'Gallery', '', 'gallery', 2, 1),
  ('featured', 'Featured', 'Featured', '', 'featured', 3, 1),
  ('about', 'About', 'About', '', 'about', 4, 1),
  ('contact', 'Contact', 'Contact', '', 'contact', 5, 1)
on conflict (id) do nothing;

create or replace function public.save_portfolio_item(p_item jsonb, p_section_slugs text[])
returns setof public.portfolio_items
language plpgsql
set search_path = public
as $$
declare
  saved public.portfolio_items;
begin
  if exists (
    select 1
    from unnest(coalesce(p_section_slugs, array[]::text[])) as selected(slug)
    where not exists (select 1 from public.sections where sections.slug = selected.slug)
  ) then
    raise exception 'One or more selected display locations do not exist.' using errcode = '23503';
  end if;

  insert into public.portfolio_items (
    id, media_id, title, description, category, location, photo_date, tags,
    is_featured, is_published, is_hidden, display_order
  )
  values (
    p_item->>'id', p_item->>'media_id', p_item->>'title',
    coalesce(p_item->>'description', ''), coalesce(p_item->>'category', ''),
    coalesce(p_item->>'location', ''), coalesce(p_item->>'photo_date', ''),
    coalesce(p_item->>'tags', ''), coalesce((p_item->>'is_featured')::smallint, 0),
    coalesce((p_item->>'is_published')::smallint, 0),
    coalesce((p_item->>'is_hidden')::smallint, 0),
    coalesce((p_item->>'display_order')::integer, 0)
  )
  on conflict (id) do update set
    media_id = excluded.media_id,
    title = excluded.title,
    description = excluded.description,
    category = excluded.category,
    location = excluded.location,
    photo_date = excluded.photo_date,
    tags = excluded.tags,
    is_featured = excluded.is_featured,
    is_published = excluded.is_published,
    is_hidden = excluded.is_hidden,
    display_order = excluded.display_order,
    updated_at = now()
  returning * into saved;

  delete from public.portfolio_item_sections
  where portfolio_item_id = saved.id;

  insert into public.portfolio_item_sections (portfolio_item_id, section_id)
  select saved.id, sections.id
  from public.sections
  where sections.slug = any(coalesce(p_section_slugs, array[]::text[]));

  return next saved;
end;
$$;

revoke all on function public.save_portfolio_item(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.save_portfolio_item(jsonb, text[]) to service_role;

create or replace function public.save_social_link(p_link jsonb, p_locations text[])
returns setof public.social_links
language plpgsql
set search_path = public
as $$
declare
  saved public.social_links;
begin
  if exists (
    select 1
    from unnest(coalesce(p_locations, array[]::text[])) as selected(location)
    where selected.location not in ('header', 'homepage', 'about', 'portfolio', 'contact', 'footer')
  ) then
    raise exception 'Unknown social display location.' using errcode = '22023';
  end if;

  insert into public.social_links (
    id, platform, display_name, url, icon, is_visible, display_order
  )
  values (
    p_link->>'id', p_link->>'platform', p_link->>'display_name',
    p_link->>'url', p_link->>'icon',
    coalesce((p_link->>'is_visible')::smallint, 1),
    coalesce((p_link->>'display_order')::integer, 0)
  )
  on conflict (id) do update set
    platform = excluded.platform,
    display_name = excluded.display_name,
    url = excluded.url,
    icon = excluded.icon,
    is_visible = excluded.is_visible,
    display_order = excluded.display_order
  returning * into saved;

  delete from public.social_link_locations
  where social_link_id = saved.id;

  insert into public.social_link_locations (social_link_id, location, display_order)
  select saved.id, selected.location, selected.ordinality - 1
  from unnest(coalesce(p_locations, array[]::text[])) with ordinality as selected(location, ordinality);

  return next saved;
end;
$$;

revoke all on function public.save_social_link(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.save_social_link(jsonb, text[]) to service_role;
