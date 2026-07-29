import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Next's default Server Action body limit is 1MB, which is well under
      // the 20MB app-level check in uploadBrandDocument (app/(app)/config/actions.ts) —
      // pitch decks and other brand-extraction documents are routinely
      // multi-MB, so without this override the framework rejects the
      // request before that check ever runs. 25mb leaves headroom over the
      // 20MB file-size cap for multipart/form-data overhead (boundaries,
      // part headers, field metadata).
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
