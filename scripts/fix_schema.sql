-- 1. Profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL,
  avatar_url TEXT,
  wins INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Public profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);


-- 2. Rooms
CREATE TABLE IF NOT EXISTS public.rooms (
  code TEXT PRIMARY KEY,
  host_id UUID REFERENCES public.profiles(id),
  settings JSONB DEFAULT '{"rounds": 10, "time": 15, "mode": "normal"}'::jsonb,
  status TEXT DEFAULT 'waiting', 
  current_round INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure game_state column exists (Idempotent)
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

DROP POLICY IF EXISTS "Host can update room" ON public.rooms;
CREATE POLICY "Host can update room" ON public.rooms FOR UPDATE USING (auth.uid() = host_id);


-- 3. Room Players
CREATE TABLE IF NOT EXISTS public.room_players (
  room_code TEXT REFERENCES public.rooms(code) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  score INTEGER DEFAULT 0,
  is_ready BOOLEAN DEFAULT false,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_code, user_id)
);

ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Room players viewable by everyone" ON public.room_players;
CREATE POLICY "Room players viewable by everyone" ON public.room_players FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can join rooms" ON public.room_players;
CREATE POLICY "Users can join rooms" ON public.room_players FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their status" ON public.room_players;
CREATE POLICY "Users can update their status" ON public.room_players FOR UPDATE USING (auth.uid() = user_id);


-- 4. Room Songs
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
CREATE POLICY "Users can add songs" ON public.room_songs FOR INSERT WITH CHECK (auth.uid() = user_id);


-- 5. Storage (Avatars)
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


-- 6. Realtime
-- Drop publication first to avoid "already exists" errors if simple addition fails, but ADD TABLE is usually safe to re-run?
-- Actually ADD TABLE will error if table is already in publication.
-- Better to just try/catch or ignore, or Re-create publication.
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime FOR TABLE public.profiles, public.rooms, public.room_players, public.room_songs;
