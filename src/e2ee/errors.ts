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
