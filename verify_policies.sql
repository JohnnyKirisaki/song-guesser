-- CHECK ACTIVE POLICIES
-- Paste the result of this query to me.

SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM
    pg_policies
WHERE
    tablename IN ('room_players', 'profiles', 'rooms')
ORDER BY
    tablename, policyname;
