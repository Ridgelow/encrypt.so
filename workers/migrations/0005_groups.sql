-- Multi-member groups share the ciphertext tables.
-- `kind` is `direct` or `group`. `title` is group metadata, not a message body.
-- `pair_key` stays unique. A group uses `group:<conversation id>` so it
-- cannot collide with a 1:1 pair of user ids.

ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE conversations ADD COLUMN title TEXT;
