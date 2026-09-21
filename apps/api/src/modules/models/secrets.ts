import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createEnvironmentSecretResolver } from '@agent-workbench/runtime';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const VERSION = 'v1';
const ASSOCIATED_DATA = 'agent-workbench:model-connection-secret';

function decodeKey(value: string): Buffer | undefined {
  const candidate = value.trim();
  if (/^[0-9a-f]{64}$/i.test(candidate)) {
    const key = Buffer.from(candidate, 'hex');
    return key.length === KEY_LENGTH ? key : undefined;
  }
  try {
    const key = Buffer.from(candidate, 'base64');
    return key.length === KEY_LENGTH ? key : undefined;
  } catch {
    return undefined;
  }
}

export function getModelSecretKey(environment: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = environment.MODEL_SECRET_ENCRYPTION_KEY;
  const key = raw ? decodeKey(raw) : undefined;
  if (!key) {
    throw new Error('MODEL_SECRET_ENCRYPTION_KEY must be a 32-byte hex or base64 key');
  }
  return key;
}

export function encryptModelSecret(secret: string, environment = process.env): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getModelSecretKey(environment), iv);
  cipher.setAAD(Buffer.from(ASSOCIATED_DATA, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptModelSecret(
  encrypted: string | null | undefined,
  environment = process.env,
): string | undefined {
  if (!encrypted) return undefined;
  const [version, ivEncoded, authTagEncoded, ciphertextEncoded] = encrypted.split(':');
  if (version !== VERSION || !ivEncoded || !authTagEncoded || !ciphertextEncoded) return undefined;
  try {
    const iv = Buffer.from(ivEncoded, 'base64url');
    const authTag = Buffer.from(authTagEncoded, 'base64url');
    const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
    if (iv.length !== IV_LENGTH || authTag.length !== 16 || ciphertext.length === 0) {
      return undefined;
    }
    const decipher = createDecipheriv(ALGORITHM, getModelSecretKey(environment), iv);
    decipher.setAAD(Buffer.from(ASSOCIATED_DATA, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

export async function resolveModelSecret(
  secretRef: string,
  secretCiphertext: string | null | undefined,
): Promise<string | undefined> {
  if (secretRef === 'managed') {
    return decryptModelSecret(secretCiphertext);
  }
  return createEnvironmentSecretResolver().resolve(secretRef);
}
