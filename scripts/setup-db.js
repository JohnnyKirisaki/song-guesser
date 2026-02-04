const { Client } = require('pg');

const connectionString = 'postgresql://postgres:[S@njiDB1527]@db.itybceqzmazrnydnifqd.supabase.co:5432/postgres';

const client = new Client({
    connectionString,
});

const sql = `
-- Create Profiles table (public profile info)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY, -- Matches auth.uid()
  username TEXT NOT NULL,
  avatar_url TEXT,
  wins INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read profiles (needed for game)
CREATE POLICY "Public profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);
-- Allow users to insert/update their own profile
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Create Rooms table
CREATE TABLE IF NOT EXISTS public.rooms (
  code TEXT PRIMARY KEY,
  host_id UUID REFERENCES public.profiles(id),
  settings JSONB DEFAULT '{"rounds": 10, "time": 15, "mode": "normal"}'::jsonb,
  status TEXT DEFAULT 'waiting', -- waiting, playing, finished
  current_round INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Rooms are viewable by everyone" ON public.rooms FOR SELECT USING (true);
CREATE POLICY "Anyone can create a room" ON public.rooms FOR INSERT WITH CHECK (true);
CREATE POLICY "Host can update room" ON public.rooms FOR UPDATE USING (auth.uid() = host_id); 

-- Create Room Players table (Join table)
CREATE TABLE IF NOT EXISTS public.room_players (
  room_code TEXT REFERENCES public.rooms(code) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  score INTEGER DEFAULT 0,
  is_ready BOOLEAN DEFAULT false,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_code, user_id)
);

ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Room players viewable by everyone" ON public.room_players FOR SELECT USING (true);
CREATE POLICY "Users can join rooms" ON public.room_players FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their status" ON public.room_players FOR UPDATE USING (auth.uid() = user_id);

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
CREATE POLICY "Songs viewable by everyone in room" ON public.room_songs FOR SELECT USING (true);
CREATE POLICY "Users can add songs" ON public.room_songs FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Storage for Avatars
insert into storage.buckets (id, name, public) 
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "Avatar images are publicly accessible"
  on storage.objects for select
  using ( bucket_id = 'avatars' );

create policy "Anyone can upload an avatar"
  on storage.objects for insert
  with check ( bucket_id = 'avatars' );

-- Realtime publication
-- We need to enable replication on these tables for realtime to work
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles, public.rooms, public.room_players, public.room_songs;
`;

async function run() {
    try {
        await client.connect();
        console.log('Connected to Supabase Postgres...');
        await client.query(sql);
        console.log('Database schema initialization successful!');
    } catch (err) {
        console.error('Error running migrations:', err);
    } finally {
        await client.end();
    }
}

run();
