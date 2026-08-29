-- Cell Clash persistence: guest profile and completed-match history.
-- Live movement, collisions and scoring belong exclusively to the game server.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Guest',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) between 2 and 18),
  constraint profiles_display_name_safe check (display_name !~ '[<>[:cntrl:]]')
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('ffa', 'teams')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  winner_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint matches_time_order check (ended_at >= started_at)
);

create table public.match_results (
  match_id uuid not null references public.matches(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  placement smallint not null check (placement between 1 and 5),
  final_mass integer not null check (final_mass >= 0),
  eliminations smallint not null default 0 check (eliminations >= 0),
  created_at timestamptz not null default now(),
  primary key (match_id, profile_id),
  unique (match_id, placement)
);

create index match_results_profile_id_created_at_idx on public.match_results (profile_id, created_at desc);
create index matches_ended_at_idx on public.matches (ended_at desc);

alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_results enable row level security;

-- Guest (anonymous) users authenticate as the authenticated role. They can only read/update their own profile.
create policy "profiles: read own" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "profiles: update own" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
grant select, update on public.profiles to authenticated;

-- Only the server using a service role records match data; no browser-facing policies are created.
revoke all on public.matches, public.match_results from anon, authenticated;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, 'Guest')
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.create_profile_for_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();
