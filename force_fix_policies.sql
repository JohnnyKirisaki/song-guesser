-- FORCE FIX POLICIES
-- This script deletes ALL existing rules for rooms and players and applies the correct ones.

-- 1. RESET ROOM PLAYERS (The Lobby List)
DROP POLICY IF EXISTS "Room players viewable by everyone" ON public.room_players;
DROP POLICY IF EXISTS "Users can join rooms" ON public.room_players;
DROP POLICY IF EXISTS "Users can update their status" ON public.room_players;
DROP POLICY IF EXISTS "Users can leave rooms" ON public.room_players;
DROP POLICY IF EXISTS "Host can remove players" ON public.room_players;
-- Drop old names
DROP POLICY IF EXISTS "Enable read access for all users" ON public.room_players;
DROP POLICY IF EXISTS "Enable insert for users based on user_id" ON public.room_players;
-- DROP NEW NAMES (To prevent "already exists" error on re-run)
DROP POLICY IF EXISTS "See Players" ON public.room_players;
DROP POLICY IF EXISTS "Join Room" ON public.room_players;
DROP POLICY IF EXISTS "Update Self" ON public.room_players;
DROP POLICY IF EXISTS "Leave Room" ON public.room_players;
DROP POLICY IF EXISTS "Host Kick" ON public.room_players;

-- NEW POLICIES FOR ROOM_PLAYERS
-- A. SEE: Everyone can see everyone
CREATE POLICY "See Players" ON public.room_players FOR SELECT USING (true);

-- B. JOIN: You can add yourself
CREATE POLICY "Join Room" ON public.room_players FOR INSERT WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- C. UPDATE: You can update your own status (Ready, etc)
CREATE POLICY "Update Self" ON public.room_players FOR UPDATE USING (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- D. LEAVE: You can delete yourself
CREATE POLICY "Leave Room" ON public.room_players FOR DELETE USING (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- E. KICK: The Host can delete anyone in their room
CREATE POLICY "Host Kick" ON public.room_players FOR DELETE USING (
  room_code IN (
    SELECT code FROM public.rooms
    WHERE host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
  )
);


-- 2. RESET ROOMS (Settings & Creation)
DROP POLICY IF EXISTS "Rooms viewable by everyone" ON public.rooms;
DROP POLICY IF EXISTS "Users can create rooms" ON public.rooms;
DROP POLICY IF EXISTS "Hosts can update their rooms" ON public.rooms;
DROP POLICY IF EXISTS "Allow cleanup of stale rooms" ON public.rooms;
-- DROP NEW NAMES
DROP POLICY IF EXISTS "See Rooms" ON public.rooms;
DROP POLICY IF EXISTS "Create Room" ON public.rooms;
DROP POLICY IF EXISTS "Host Update" ON public.rooms;
DROP POLICY IF EXISTS "Host Delete" ON public.rooms;
DROP POLICY IF EXISTS "System Cleanup" ON public.rooms;

-- NEW POLICIES FOR ROOMS
-- A. SEE: Everyone sees rooms
CREATE POLICY "See Rooms" ON public.rooms FOR SELECT USING (true);

-- B. CREATE: Authenticated users create rooms
CREATE POLICY "Create Room" ON public.rooms FOR INSERT WITH CHECK (
  host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- C. UPDATE: Host updates settings
CREATE POLICY "Host Update" ON public.rooms FOR UPDATE USING (
  host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- D. DELETE: Host deletes room OR Cleanup
CREATE POLICY "Host Delete" ON public.rooms FOR DELETE USING (
  host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- Cleanup Policy (Stale rooms)
CREATE POLICY "System Cleanup" ON public.rooms FOR DELETE USING (
  created_at < (now() - interval '24 hours')
);


-- 3. RESET PROFILES (The Missing Link!)
-- If you can't see other players, it's likely because you can't see their PROFILE.
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
-- Drop old/default ones
DROP POLICY IF EXISTS "Public profiles are referenced by everyone" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
-- DROP NEW NAMES
DROP POLICY IF EXISTS "See Profiles" ON public.profiles;
DROP POLICY IF EXISTS "Create Profile" ON public.profiles;
DROP POLICY IF EXISTS "Update Profile" ON public.profiles;

-- NEW POLICIES FOR PROFILES
-- A. SEE: Everyone sees everyone's name/avatar
CREATE POLICY "See Profiles" ON public.profiles FOR SELECT USING (true);

-- B. INSERT: You can create your profile
CREATE POLICY "Create Profile" ON public.profiles FOR INSERT WITH CHECK (
  (select auth.uid()) = id
);

-- C. UPDATE: You update your own
CREATE POLICY "Update Profile" ON public.profiles FOR UPDATE USING (
  (select auth.uid()) = id
);

-- Output to confirm success
SELECT 'Policies (Rooms + Players + Profiles) successfully reset!' as status;
