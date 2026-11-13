import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

/*
 * A software passkey: one P-256 key, answering WebAuthn registration and
 * authentication as a browser would pass them on, with the user
 * verification (UV) flag set or not. Attestation is "none", so the only
 * CBOR it writes is the attestation object and the COSE public key.
 */

export type SoftwarePasskey = {
  /** The body of POST /api/auth/passkey/verify-registration. */
  registration(challenge: string, userVerified: boolean): unknown;
  /** The body of POST /api/auth/passkey/verify-authentication. */
  assertion(challenge: string, userVerified: boolean): unknown;
};

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

/** A CBOR byte or text string header (major type 2 or 3), for lengths under 256. */
function cborString(major: 2 | 3, value: Buffer): Buffer {
  const head =
    value.length < 24
      ? [(major << 5) | value.length]
      : [(major << 5) | 24, value.length];
  return Buffer.concat([Buffer.from(head), value]);
}

const text = (value: string) => cborString(3, Buffer.from(value));
const bytes = (value: Buffer) => cborString(2, value);

export function softwarePasskey(rpId: string, origin: string): SoftwarePasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const coordinate = (value: string | undefined) =>
    Buffer.from(String(value), "base64url");
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const coseKey = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
    bytes(coordinate(jwk.x)),
    Buffer.from([0x22]),
    bytes(coordinate(jwk.y)),
  ]);
  const credentialId = randomBytes(16);
  const id = credentialId.toString("base64url");
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const counter = Buffer.alloc(4);
  const flags = (userVerified: boolean, extra = 0) =>
    Buffer.from([USER_PRESENT | (userVerified ? USER_VERIFIED : 0) | extra]);
  const clientData = (type: string, challenge: string) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  const credential = (response: Record<string, unknown>) => ({
    response: {
      id,
      rawId: id,
      type: "public-key",
      response,
      clientExtensionResults: {},
    },
  });

  return {
    registration(challenge, userVerified) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpIdHash,
        flags(userVerified, ATTESTED_CREDENTIAL),
        counter,
        Buffer.alloc(16),
        length,
        credentialId,
        coseKey,
      ]);
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3]),
        text("fmt"),
        text("none"),
        text("attStmt"),
        Buffer.from([0xa0]),
        text("authData"),
        bytes(authData),
      ]);
      return credential({
        clientDataJSON: clientData("webauthn.create", challenge).toString(
          "base64url",
        ),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      });
    },
    assertion(challenge, userVerified) {
      const authenticatorData = Buffer.concat([
        rpIdHash,
        flags(userVerified),
        counter,
      ]);
      const json = clientData("webauthn.get", challenge);
      const signature = sign(
        "sha256",
        Buffer.concat([
          authenticatorData,
          createHash("sha256").update(json).digest(),
        ]),
        privateKey,
      );
      return credential({
        clientDataJSON: json.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
      });
    },
  };
}
