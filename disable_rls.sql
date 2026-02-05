-- NUCLEAR OPTION: DISABLE RLS
-- This turns off all security checks for these tables.
-- If this fixes the issue, we know 100% it was a Policy bug.

ALTER TABLE public.room_players DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms DISABLE ROW LEVEL SECURITY;

-- Verify
SELECT relname, relrowsecurity 
FROM pg_class 
WHERE relname IN ('room_players', 'profiles', 'rooms');
