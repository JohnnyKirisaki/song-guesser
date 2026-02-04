-- Allow anyone to delete rooms that are 'finished' or older than 30 minutes
CREATE POLICY "Allow cleanup of stale rooms" ON public.rooms
FOR DELETE
USING (
  status = 'finished' 
  OR 
  created_at < (now() - interval '30 minutes')
);
