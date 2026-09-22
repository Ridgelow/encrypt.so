export class DeviceKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class DeviceKeyStoreUnavailableError extends DeviceKeyError {
  constructor() {
    super("Secure storage is not available on this device.");
  }
}

export class DeviceKeyGenerationError extends DeviceKeyError {
  constructor() {
    super("Device key generation failed verification.");
  }
}

export class DeviceKeyRecordError extends DeviceKeyError {
  constructor() {
    super("Stored device keys are unreadable.");
  }
}

export class BundleUploadError extends DeviceKeyError {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Bundle upload failed (${status} ${code})`);
    this.status = status;
    this.code = code;
  }
}

export class SessionUnavailableError extends DeviceKeyError {
  constructor() {
    super("A signed-in session is required before starting an encrypted conversation.");
  }
}

export class SessionKeysMissingError extends DeviceKeyError {
  constructor() {
    super("Device keys are not on this device yet.");
  }
}

export class SessionBundleError extends DeviceKeyError {
  constructor() {
    super("No public prekey bundle is available for that user.");
  }
}

export class SessionNotEstablishedError extends DeviceKeyError {
  constructor() {
    super("No encrypted session exists with that device yet.");
  }
}

export class SessionRecordError extends DeviceKeyError {
  constructor() {
    super("Stored sessions are unreadable.");
  }
}

/** Refuses to return an envelope that contains private key material. */
export class SessionLeakError extends DeviceKeyError {
  constructor() {
    super("Refusing to emit private key material.");
  }
}

export class SessionMessageError extends DeviceKeyError {
  constructor() {
    super("Encrypted message is unreadable.");
  }
}

export class AttachmentError extends DeviceKeyError {
  constructor() {
    super("Encrypted attachment is unreadable.");
  }
}
