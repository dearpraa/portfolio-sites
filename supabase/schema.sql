-- Run this once in the Supabase SQL Editor.
create table if not exists public.media (
  id text primary key, file_name text not null, file_url text not null unique,
  mime_type text not null, alt_text text not null default '',
  created_at timestamptz not null default now(), ai_metadata text
);
create table if not exists public.sections (
  id text primary key, name text not null, title text not null,
  description text not null default '', slug text not null unique,
  is_visible boolean not null default true, display_order integer not null default 0,
  is_system boolean not null default false
);
create table if not exists public.portfolio_items (
  id text primary key, media_id text not null references public.media(id) on delete restrict,
  title text not null, description text not null default '', category text not null default '',
  location text not null default '', photo_date text not null default '', tags text not null default '',
  is_featured boolean not null default false, is_published boolean not null default false,
  display_order integer not null default 0, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), is_hidden boolean not null default false
);
create table if not exists public.portfolio_item_sections (
  portfolio_item_id text not null references public.portfolio_items(id) on delete cascade,
  section_id text not null references public.sections(id) on delete cascade,
  primary key (portfolio_item_id, section_id)
);
create table if not exists public.social_links (
  id text primary key, platform text not null, display_name text not null,
  url text not null, icon text not null, is_visible boolean not null default true,
  display_order integer not null default 0
);
create table if not exists public.social_link_locations (
  social_link_id text not null references public.social_links(id) on delete cascade,
  location text not null, display_order integer not null default 0,
  primary key (social_link_id, location)
);
create table if not exists public.site_content (
  content_key text primary key, content_value text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.navigation_items (
  id text primary key, label text not null, url text not null,
  icon text not null default '', is_visible boolean not null default true,
  display_order integer not null default 0
);
create table if not exists public.skills (
  id text primary key, name text not null, percent integer not null default 80,
  icon text not null default 'ri-star-line', display_order integer not null default 0,
  is_visible boolean not null default true
);

create index if not exists portfolio_published_order on public.portfolio_items(is_published, display_order);
create index if not exists portfolio_sections_section on public.portfolio_item_sections(section_id);
create index if not exists social_locations on public.social_link_locations(location);

insert into public.sections(id,name,title,slug,display_order,is_system)
values
('home','Homepage','Homepage','homepage',0,true),
('portfolio','Portfolio','Portfolio','portfolio',1,true),
('gallery','Gallery','Gallery','gallery',2,true),
('featured','Featured','Featured','featured',3,true),
('about','About','About','about',4,true),
('contact','Contact','Contact','contact',5,true)
on conflict (id) do nothing;

insert into storage.buckets(id,name,public)
values('portfolio-images','portfolio-images',true)
on conflict (id) do update set public=true;

-- The CMS server uses the Supabase secret key, so it bypasses RLS.
-- Public images are intentionally readable because the portfolio is public.
