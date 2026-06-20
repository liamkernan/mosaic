import { timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";
import { AbuseDetectedError, ConfigError, getEnv } from "@mosaic/core";

const intakeSecretHeader = "x-mosaic-intake-secret";

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = headerValue(request, "authorization")?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function intakeAuthHeaders(secret: string): Record<string, string> {
  return {
    [intakeSecretHeader]: secret
  };
}

export function assertTrustedIntakeRequest(request: FastifyRequest): void {
  const expectedSecret = getEnv().MOSAIC_INTAKE_SHARED_SECRET;
  if (!expectedSecret) {
    throw new ConfigError("MOSAIC_INTAKE_SHARED_SECRET is required for trusted intake webhooks");
  }

  const suppliedSecret = headerValue(request, intakeSecretHeader)?.trim() ?? bearerToken(request);
  if (!suppliedSecret || !constantTimeEquals(suppliedSecret, expectedSecret)) {
    throw new AbuseDetectedError("Unauthorized intake webhook request");
  }
}
