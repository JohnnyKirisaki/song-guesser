-- 1. Ensure PUBLIC schema is accessible
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

-- 2. Ensure ALL tables are accessible (SELECT, INSERT, UPDATE, DELETE)
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;

-- 3. Ensure ALL sequences are accessible (for ID generation)
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;

-- 4. DEBUG FUNCTION: Count players ignoring RLS
CREATE OR REPLACE FUNCTION get_debug_player_count(p_room_code TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER -- Runs as database owner (bypasses RLS)
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.room_players
  WHERE room_code = p_room_code;
  
  RETURN v_count;
END;
$$;
