-- Run this in your Supabase SQL Editor
ALTER TABLE public.room_players ADD COLUMN IF NOT EXISTS playlist_url TEXT;
