-- Create Profiles table (public profile info)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY, -- Matches auth.uid() (initially)
  username TEXT NOT NULL,
  avatar_url TEXT,
  wins INTEGER DEFAULT 0,
  last_auth_id UUID, -- Links to current active session
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read profiles (needed for game)
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Public profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);

-- Allow users to insert/update their own profile (via ID or last_auth_id)
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id OR auth.uid() = last_auth_id);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id OR auth.uid() = last_auth_id);

-- RPC for Claiming Profile
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
    -- Exists: Update auth link
    -- Only update avatar if a new one is provided
    UPDATE public.profiles 
    SET last_auth_id = auth.uid(),
        avatar_url = CASE WHEN p_avatar_url IS NULL OR p_avatar_url = '' THEN avatar_url ELSE p_avatar_url END
    WHERE id = v_profile_id;
    RETURN v_profile_id;
  ELSE
    -- New: Create
    -- We use auth.uid() as ID for new users for simplicity
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

-- Create Rooms table
CREATE TABLE IF NOT EXISTS public.rooms (
  code TEXT PRIMARY KEY,
  host_id UUID REFERENCES public.profiles(id),
  settings JSONB DEFAULT '{"rounds": 10, "time": 15, "mode": "normal"}'::jsonb,
  game_state JSONB, -- Stores the full current game state (playlist, phase, etc)
  status TEXT DEFAULT 'waiting', -- waiting, playing, finished
  current_round INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safe migration for existing tables
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rooms' AND column_name = 'game_state') THEN
        ALTER TABLE public.rooms ADD COLUMN game_state JSONB;
    END IF;
END $$;

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Rooms are viewable by everyone" ON public.rooms;
CREATE POLICY "Rooms are viewable by everyone" ON public.rooms FOR SELECT USING (true);

DROP POLICY IF EXISTS "Anyone can create a room" ON public.rooms;
CREATE POLICY "Anyone can create a room" ON public.rooms FOR INSERT WITH CHECK (true);

-- Helper for RLS: Check if auth user owns the profile of the row
-- Just inlining the logic in checks involves a join, or we assume a session variable.
-- Performance-wise, a subquery is okay for small scale.

DROP POLICY IF EXISTS "Host can update room" ON public.rooms;
CREATE POLICY "Host can update room" ON public.rooms FOR UPDATE USING (
  host_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
); 

-- Create Room Players table (Join table)
CREATE TABLE IF NOT EXISTS public.room_players (
  room_code TEXT REFERENCES public.rooms(code) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  score INTEGER DEFAULT 0,
  is_ready BOOLEAN DEFAULT false,
  has_submitted BOOLEAN DEFAULT false,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_code, user_id)
);

ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;

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

-- Create Songs table (Songs in a room's pool)
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

DROP POLICY IF EXISTS "Songs viewable by everyone in room" ON public.room_songs;
CREATE POLICY "Songs viewable by everyone in room" ON public.room_songs FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can add songs" ON public.room_songs;
CREATE POLICY "Users can add songs" ON public.room_songs FOR INSERT WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- Storage for Avatars
insert into storage.buckets (id, name, public) 
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

DROP POLICY IF EXISTS "Avatar images are publicly accessible" ON storage.objects;
create policy "Avatar images are publicly accessible"
  on storage.objects for select
  using ( bucket_id = 'avatars' );

DROP POLICY IF EXISTS "Anyone can upload an avatar" ON storage.objects;
create policy "Anyone can upload an avatar"
  on storage.objects for insert
  with check ( bucket_id = 'avatars' );

-- Create Guesses table for Stats
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

DROP POLICY IF EXISTS "Guesses viewable by everyone" ON public.room_guesses;
CREATE POLICY "Guesses viewable by everyone" ON public.room_guesses FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert guesses" ON public.room_guesses;
CREATE POLICY "Users can insert guesses" ON public.room_guesses FOR INSERT WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE last_auth_id = auth.uid())
);

-- Realtime publication
-- We use SET TABLE to ensure it's idempotent (replaces list instead of trying to add)
-- Note: You might need to check if publication exists first, but `supabase_realtime` usually exists.
-- If not, create it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;

ALTER PUBLICATION supabase_realtime SET TABLE public.profiles, public.rooms, public.room_players, public.room_songs, public.room_guesses;
