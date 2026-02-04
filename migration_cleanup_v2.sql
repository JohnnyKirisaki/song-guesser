
-- 1. Add finished_at column
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

-- 2. Drop the old aggressive cleanup policy
DROP POLICY IF EXISTS "Allow cleanup of stale rooms" ON public.rooms;

-- 3. Create a safer cleanup policy:
-- Delete if:
--   (status is finished AND finished_at is older than 60 seconds)
--   OR
--   (created_at is older than 30 minutes)
CREATE POLICY "Allow cleanup of stale rooms" ON public.rooms
FOR DELETE
USING (
  (status = 'finished' AND finished_at < (now() - interval '60 seconds'))
  OR 
  (created_at < (now() - interval '30 minutes'))
);
