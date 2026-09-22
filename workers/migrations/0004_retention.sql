-- Server retention for ciphertext rows is `created_at` plus MESSAGE_TTL_MS.
-- `messages.expire_at` stays the client disappearing-message deadline.
-- Attachment pointers record the R2 object id only. No filename or plaintext.

CREATE TABLE attachment_objects (
  object_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expire_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

CREATE INDEX idx_attachment_objects_expire ON attachment_objects (expire_at);
CREATE INDEX idx_attachment_objects_conversation ON attachment_objects (conversation_id, created_at);

CREATE INDEX idx_messages_expire ON messages (expire_at) WHERE expire_at IS NOT NULL;
CREATE INDEX idx_messages_created ON messages (created_at);
