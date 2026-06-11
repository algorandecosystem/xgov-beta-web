import { defineMiddleware } from "astro:middleware";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
};

function getAllowedOrigins(): string[] {
  const raw =
    (typeof process !== "undefined" && process.env.CORS_ORIGIN) ||
    import.meta.env.CORS_ORIGIN ||
    "";
  return raw
    .split(",")
    .map((o: string) => o.trim())
    .filter(Boolean);
}

function resolveOrigin(requestOrigin: string | null): string | null {
  if (!requestOrigin) return null;
  const allowed = getAllowedOrigins();
  if (allowed.length === 0) return null;
  if (allowed.includes("*")) return requestOrigin;
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

export const onRequest = defineMiddleware(({ request }, next) => {
  const requestOrigin = request.headers.get("origin");
  const origin = resolveOrigin(requestOrigin);

  // Preflight
  if (request.method === "OPTIONS") {
    const headers: Record<string, string> = { ...CORS_HEADERS };
    if (origin) headers["Access-Control-Allow-Origin"] = origin;
    return new Response(null, { status: 204, headers });
  }

  return next().then((response) => {
    if (origin) {
      response.headers.set("Access-Control-Allow-Origin", origin);
    }
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      response.headers.set(key, value);
    }
    return response;
  });
});
