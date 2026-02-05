-- RUN THIS IN SUPABASE SQL EDITOR AND PASTE THE OUTPUT ("Results") HERE
-- This will tell me exactly what policies are active and preventing visibility.

SELECT
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
    schemaname = 'public';

-- Also check RLS status on tables
SELECT
    relname,
    relrowsecurity
FROM
    pg_class
JOIN
    pg_namespace ON pg_namespace.oid = pg_class.relnamespace
WHERE
    pg_namespace.nspname = 'public'
    AND relkind = 'r';
