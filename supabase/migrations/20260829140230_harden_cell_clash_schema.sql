-- Explicit browser denial documents that match data is write-only for the server.
create policy "matches: deny browser access" on public.matches as restrictive for all to authenticated using (false) with check (false);
create policy "match results: deny browser access" on public.match_results as restrictive for all to authenticated using (false) with check (false);

-- Supports winner lookups and resolves the foreign-key index advisory.
create index matches_winner_profile_id_idx on public.matches (winner_profile_id);

-- Existing event-trigger helper must not be invokable through the public RPC surface.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
