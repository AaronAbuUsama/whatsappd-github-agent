import { randomBytes, timingSafeEqual } from "node:crypto";

const token = randomBytes(32).toString("base64url");
export const scribeDirectToken = (): string => token;
export const scribeDirectBaseUrl = (runtimePort: number): string => `http://127.0.0.1:${runtimePort}`;
export const acceptsScribeDirectToken = (authorization: string | undefined): boolean => {
  const candidate = authorization?.replace(/^Bearer /, "") ?? "";
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
};
