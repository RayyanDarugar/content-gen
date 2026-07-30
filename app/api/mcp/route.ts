import { createMcpHandler } from "mcp-handler";
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";

// Every tool-registration task below (8, 9, 11) adds server.registerTool(...)
// calls inside this same callback, closing over `userId` from the
// authenticated request — there is no session state between requests (the
// installed mcp-handler is stateless: no session ids, no Redis), so a fresh
// handler is built per call, matching the app's existing per-request
// admin-client pattern.
async function handleMcp(request: NextRequest): Promise<Response> {
  let userId: string;
  try {
    userId = (await requireUser(request)).id;
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handler = createMcpHandler((server) => {
    server.registerTool(
      "whoami",
      { title: "Who am I", description: "Returns the authenticated user id — used to verify the connection is wired correctly." },
      async () => ({ content: [{ type: "text", text: userId }] }),
    );
    // Tasks 8, 9, and 11 register the real tool surface here.
  });

  return handler(request);
}

export { handleMcp as GET, handleMcp as POST, handleMcp as DELETE };
