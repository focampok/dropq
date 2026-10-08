import { timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "dropq_sid";

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim() ?? "";
  if (!secret) {
    throw new Error("SESSION_SECRET is not set");
  }
  return secret;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return new Uint8Array(signature);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fixedEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  paddedLeft.set(leftBytes.subarray(0, length));
  paddedRight.set(rightBytes.subarray(0, length));
  const equal = timingSafeEqual(paddedLeft, paddedRight);
  return equal && leftBytes.length === rightBytes.length;
}

export async function sealSessionId(sessionId: string): Promise<string> {
  const signature = bytesToBase64Url(await hmac(sessionSecret(), sessionId));
  return `${sessionId}.${signature}`;
}

export async function openSessionCookie(value: string): Promise<string | null> {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const sessionId = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!sessionId || !signature) return null;
  const expected = bytesToBase64Url(await hmac(sessionSecret(), sessionId));
  if (!fixedEqual(signature, expected)) return null;
  return sessionId;
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function readSessionCookie(request: Request): string | undefined {
  return readCookie(request, COOKIE_NAME);
}

export const sessionCookie = {
  name: COOKIE_NAME,
  options: {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  },
};
