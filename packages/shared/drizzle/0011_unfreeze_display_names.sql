-- Give back the accounts that were named after their own key.
--
-- Sign-up used to write the *rendered* form of the npub into `users.name` —
-- truncated, with a literal ellipsis. That is a display decision, and storing
-- it froze one: it could not be copied, it could not be told apart from a name
-- somebody had actually chosen, and the fallback that would have rendered it
-- better never ran again.
--
-- Blank now means "not named yet", and `displayName()` answers from the key at
-- render time.
--
-- The predicate matches the generated shape and only that: begins with the
-- bech32 prefix *and* contains the ellipsis that only truncation puts there.
-- A name somebody typed cannot look like this by accident, and in the
-- vanishing case where one did, the row renders as the same string it did
-- before — derived rather than stored.
UPDATE users
SET name = ''
WHERE name LIKE 'npub1%'
  AND name LIKE '%' || CHAR(8230) || '%';
