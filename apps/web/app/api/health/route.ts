export function GET(): Response {
  return Response.json({ data: { status: "ok" } });
}
