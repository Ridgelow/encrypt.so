-- Conversation metadata and opaque message ciphertext.
-- The worker never decrypts. Do not add plaintext, body, or text columns.

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  -- Canonical 1:1 identity: the two user ids, sorted and joined. Not message content.
  pair_key TEXT NOT NULL UNIQUE
);

CREATE TABLE memberships (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_memberships_user ON memberships (user_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  -- Opaque ciphertext (base64 text). The worker does not decode or inspect it.
  ciphertext TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expire_at INTEGER,
  client_id TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  FOREIGN KEY (sender_device_id) REFERENCES devices (id)
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at, id);

CREATE UNIQUE INDEX idx_messages_client_id
  ON messages (conversation_id, sender_device_id, client_id)
  WHERE client_id IS NOT NULL;
