import { proxyApiRequest } from "@/lib/api";

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const headers = new Headers({ "content-type": "application/json" });
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null) {
    headers.set("idempotency-key", idempotencyKey);
  }
  const upstream = await proxyApiRequest("/api/v1/research-jobs", {
    method: "POST",
    headers,
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
