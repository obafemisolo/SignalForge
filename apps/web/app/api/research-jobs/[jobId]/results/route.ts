import { proxyApiRequest } from "@/lib/api";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { jobId } = await context.params;
  const query = new URL(request.url).search;
  const upstream = await proxyApiRequest(
    `/api/v1/research-jobs/${encodeURIComponent(jobId)}/results${query}`,
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
