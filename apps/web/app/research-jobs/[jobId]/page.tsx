import ResearchJobDetails from "./research-job-details";

export default async function ResearchJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  return <ResearchJobDetails jobId={jobId} />;
}
