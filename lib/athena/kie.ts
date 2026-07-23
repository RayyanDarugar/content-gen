import "server-only";
import type { KieRecord } from "@/lib/athena/poll-logic";

function kieHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export async function uploadStyleRef(apiKey: string, styleRefUrl: string): Promise<string> {
  const res = await fetch("https://kieai.redpandaai.co/api/file-url-upload", {
    method: "POST",
    headers: kieHeaders(apiKey),
    body: JSON.stringify({
      fileUrl: styleRefUrl,
      uploadPath: "athena-refs",
      fileName: "style_ref.jpg",
    }),
  });
  const json = await res.json().catch(() => null);
  const url = json?.data?.downloadUrl;
  if (!res.ok || !url) {
    throw new Error(
      `style ref upload failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return url as string;
}

export async function createKieTask(
  apiKey: string,
  prompt: string,
  styleUrl: string,
  aspectRatio: string,
): Promise<string> {
  const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: kieHeaders(apiKey),
    body: JSON.stringify({
      model: "gpt-image-2-image-to-image",
      input: { prompt, input_urls: [styleUrl], aspect_ratio: aspectRatio },
    }),
  });
  const json = await res.json().catch(() => null);
  const taskId = json?.data?.taskId;
  if (!res.ok || !taskId) {
    throw new Error(
      `Kie createTask failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return taskId as string;
}

export async function getKieRecord(apiKey: string, taskId: string): Promise<KieRecord> {
  const res = await fetch(
    `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { headers: kieHeaders(apiKey) },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data) {
    throw new Error(`Kie recordInfo failed (HTTP ${res.status})`);
  }
  const state: string = json.data.state ?? "unknown";
  let resultUrl: string | null = null;
  try {
    const parsed = JSON.parse(json.data.resultJson || '{"resultUrls":[]}');
    resultUrl = parsed.resultUrls?.[0] ?? null;
  } catch {
    resultUrl = null;
  }
  return { state, resultUrl };
}
