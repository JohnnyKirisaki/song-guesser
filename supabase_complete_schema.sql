-- =============================================================================
-- SONG GUESSER - COMPLETE DATABASE SCHEMA
-- Run this in the Supabase SQL Editor to initialize a fresh database.
-- Includes all features: Profiles, Rooms, Game Logic, Cleanup, Sudden Death.
-- =============================================================================

-- 1. PROFILES
-- Public profile info linked to Auth
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY, -- Matches auth.uid()
  username TEXT NOT NULL,
  avatar_url TEXT,
  wins INTEGER DEFAULT 0,
  last_auth_id UUID, -- Links to current active session
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Public profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id OR auth.uid() = last_auth_id);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id OR auth.uid() = last_auth_id);

-- Profile Claiming RPC
CREATE OR REPLACE FUNCTION claim_profile(p_username TEXT, p_avatar_url TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile_id UUID;
BEGIN
  -- Check content (Case insensitive)
  SELECT id INTO v_profile_id FROM public.profiles WHERE lower(username) = lower(p_username);
  
  IF v_profile_id IS NOT NULL THEN
    -- Exists: Update auth link and avatar
    UPDATE public.profiles 
    SET last_auth_id = auth.uid(),
        avatar_url = CASE WHEN p_avatar_url IS NULL OR p_avatar_url = '' THEN avatar_url ELSE p_avatar_url END
    WHERE id = v_profile_id;
    RETURN v_profile_id;
  ELSE
    -- New: Create
    INSERT INTO public.profiles (id, username, avatar_url, last_auth_id)
    VALUES (
      auth.uid(), 
      p_username, 
      CASE WHEN p_avatar_url IS NULL OR p_avatar_url = '' THEN 'https://api.dicebear.com/7.x/avataaars/svg?seed=' || p_username ELSE p_avatar_url END,
      auth.uid()
    )
    RETURNING id INTO v_profile_id;
    RETURN v_profile_id;
  END IF;
END;
$$;


-- 2. ROOMS
-- Game rooms with state and settings
CREATE TABLE IF NOT EXISTS public.rooms (
  code TEXT PRIMARY KEY,
  host_id UUID REFERENCES public.profiles(id),
  settings JSONB DEFAULT '{"rounds": 10, "time": 15, "mode": "normal"}'::jsonb,
  game_state JSONB, -- Stores the full current game state
  status TEXT DEFAULT 'waiting', -- waiting, playing, finished
  current_round INTEGER DEFAULT 0,
  finished_at TIMESTAMPTZ, -- For cleanup logic
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "Rooms are viewable by everyone" ON public.rooms;
CREATE POLICY "Rooms are viewable by everyone" ON public.rooms FOR SELECT USING (true);

DROP POLICY IF EXISTS "Anyone can create a room" ON public.rooms;
CREATE POLICY "Anyone can create a room" ON public.rooms FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Host can update room" ON public.rooms;
CREATE POLICY "Host can update room" ON public.rooms FOR UPDATE USING (
  host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- CLEANUP POLICY (Smart Cleanup)
-- Delete if finished > 60s ago OR created > 30mins ago
DROP POLICY IF EXISTS "Allow cleanup of stale rooms" ON public.rooms;
CREATE POLICY "Allow cleanup of stale rooms" ON public.rooms
FOR DELETE
USING (
  (status = 'finished' AND finished_at < (now() - interval '60 seconds'))
  OR 
  (created_at < (now() - interval '30 minutes'))
);


-- 3. ROOM PLAYERS
-- Players in a room
CREATE TABLE IF NOT EXISTS public.room_players (
  room_code TEXT REFERENCES public.rooms(code) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  score INTEGER DEFAULT 0,
  is_ready BOOLEAN DEFAULT false,
  has_submitted BOOLEAN DEFAULT false,
  playlist_url TEXT, -- Stored for Sudden Death "Fetch More" feature
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_code, user_id)
);

ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "Room players viewable by everyone" ON public.room_players;
CREATE POLICY "Room players viewable by everyone" ON public.room_players FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can join rooms" ON public.room_players;
CREATE POLICY "Users can join rooms" ON public.room_players FOR INSERT WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

DROP POLICY IF EXISTS "Users can update their status" ON public.room_players;
CREATE POLICY "Users can update their status" ON public.room_players FOR UPDATE USING (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);


-- 4. ROOM SONGS
-- Songs added to the room pool
CREATE TABLE IF NOT EXISTS public.room_songs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_code TEXT REFERENCES public.rooms(code) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id),
  spotify_uri TEXT NOT NULL,
  artist_name TEXT,
  track_name TEXT,
  cover_url TEXT,
  preview_url TEXT,
  picked_by_user_id UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.room_songs ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "Songs viewable by everyone in room" ON public.room_songs;
CREATE POLICY "Songs viewable by everyone in room" ON public.room_songs FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can add songs" ON public.room_songs;
CREATE POLICY "Users can add songs" ON public.room_songs FOR INSERT WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);


-- 5. ROOM GUESSES
-- Statistics / Guesses for resolving rounds
CREATE TABLE IF NOT EXISTS public.room_guesses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_code TEXT REFERENCES public.rooms(code) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  song_id UUID REFERENCES public.room_songs(id),
  is_correct BOOLEAN DEFAULT false,
  time_taken INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.room_guesses ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "Guesses viewable by everyone" ON public.room_guesses;
CREATE POLICY "Guesses viewable by everyone" ON public.room_guesses FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert guesses" ON public.room_guesses;
CREATE POLICY "Users can insert guesses" ON public.room_guesses FOR INSERT WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);


-- 6. STORAGE (Avatars)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Avatar images are publicly accessible" ON storage.objects;
CREATE POLICY "Avatar images are publicly accessible"
  ON storage.objects FOR SELECT
  USING ( bucket_id = 'avatars' );

DROP POLICY IF EXISTS "Anyone can upload an avatar" ON storage.objects;
CREATE POLICY "Anyone can upload an avatar"
  ON storage.objects FOR INSERT
  WITH CHECK ( bucket_id = 'avatars' );


-- 7. REALTIME PUBLICATION
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;

ALTER PUBLICATION supabase_realtime SET TABLE public.profiles, public.rooms, public.room_players, public.room_songs, public.room_guesses;

-- END OF SCHEMA
