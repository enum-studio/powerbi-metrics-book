import {
  Decrypter,
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";

/*
 * The one module that imports age-encryption. It is pre-1.0, so a change in
 * its interface lands here alone. Identities are X25519, as in the spec: a
 * string AGE-SECRET-KEY-1..., whose recipient (public half) is age1...
 */

export function generateIdentity(): Promise<string> {
  return generateX25519Identity();
}

export function recipientOf(identity: string): Promise<string> {
  return identityToRecipient(identity);
}

export function encryptFor(
  recipients: readonly string[],
  text: string,
): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  return encrypter.encrypt(text);
}

/** Rejects when the ciphertext was not encrypted to this identity. */
export function decryptWith(
  identity: string,
  ciphertext: Uint8Array,
): Promise<string> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(ciphertext, "text");
}
