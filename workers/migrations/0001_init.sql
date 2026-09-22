-- encrypt.so metadata. Public identity material only.
-- Private keys are generated on device and must never be added to these tables.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  identity_key TEXT,
  signed_prekey_id INTEGER,
  signed_prekey_public TEXT,
  signed_prekey_signature TEXT,
  bundle_updated_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_devices_user_id ON devices (user_id);

CREATE TABLE one_time_prekeys (
  device_id TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (device_id, key_id),
  FOREIGN KEY (device_id) REFERENCES devices (id)
);

CREATE INDEX idx_otpk_available ON one_time_prekeys (device_id, consumed_at, key_id);
