import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";

// 32 bytes base64 for tests.
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

describe("secrets", () => {
  beforeEach(() => { process.env.SECRETS_ENC_KEY = KEY_A; });
  afterEach(() => { delete process.env.SECRETS_ENC_KEY; });

  it("round-trips a value", () => {
    const secret = "sk-ant-api03-abc123";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertext each call (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("throws when decrypting with a different key", () => {
    const blob = encryptSecret("secret");
    process.env.SECRETS_ENC_KEY = KEY_B;
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("throws on a tampered blob", () => {
    const blob = encryptSecret("secret");
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("fails closed when SECRETS_ENC_KEY is unset", () => {
    delete process.env.SECRETS_ENC_KEY;
    expect(() => encryptSecret("x")).toThrow(/SECRETS_ENC_KEY/);
  });

  it("throws if the key is not 32 bytes", () => {
    process.env.SECRETS_ENC_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});
