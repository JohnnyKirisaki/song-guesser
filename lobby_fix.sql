-- =============================================================================
-- LOBBY SYSTEM FIXES
-- Run this to enable "Leave Room" and "Kick Player" functionality.
-- =============================================================================

-- 1. Enable DELETE on room_players for the user themselves (Leave)
DROP POLICY IF EXISTS "Users can leave rooms" ON public.room_players;
CREATE POLICY "Users can leave rooms" ON public.room_players FOR DELETE USING (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- 2. Enable DELETE on room_players for the Host (Kick)
DROP POLICY IF EXISTS "Host can remove players" ON public.room_players;
CREATE POLICY "Host can remove players" ON public.room_players FOR DELETE USING (
  room_code IN (
    SELECT code FROM public.rooms 
    WHERE host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
  )
);

-- 3. Ensure Room Updates are allowed for Host (Settings, Game State)
-- (Existing policy might be sufficient, but reinforcing)
DROP POLICY IF EXISTS "Host can update room" ON public.rooms;
CREATE POLICY "Host can update room" ON public.rooms FOR UPDATE USING (
  host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- 4. Allow Host to Delete Room (Cancel Game)
DROP POLICY IF EXISTS "Host can delete room" ON public.rooms;
CREATE POLICY "Host can delete room" ON public.rooms FOR DELETE USING (
  host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);
