-- Expo push tokens for a user and, when known, their device.
-- Tokens are opaque installation ids. Do not store message plaintext or ciphertext here.

CREATE TABLE push_tokens (
  expo_push_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (device_id) REFERENCES devices (id)
);

CREATE INDEX idx_push_tokens_user ON push_tokens (user_id, device_id);
