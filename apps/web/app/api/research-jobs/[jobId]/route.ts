import { proxyApiRequest } from "@/lib/api";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { jobId } = await context.params;
  const upstream = await proxyApiRequest(
    `/api/v1/research-jobs/${encodeURIComponent(jobId)}`,
  );
  return forward(upstream);
}

export async function POST(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { jobId } = await context.params;
  const upstream = await proxyApiRequest(
    `/api/v1/research-jobs/${encodeURIComponent(jobId)}/retry`,
    { method: "POST" },
  );
  return forward(upstream);
}

function forward(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
