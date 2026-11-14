import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const GH_PATH =
  /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(pulls(\/\d+)?|commits)(\?[A-Za-z0-9_=&.%-]*)?$/;
export const GH_OUTPUT_LIMIT = 4 * 1024 * 1024;

export const hostContract = defineRpcContract({
  ghApi: {
    experimental_retryable: true,
    input: z.object({ path: z.string().regex(GH_PATH) }).strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), body: z.string() }).strict(),
      z.object({ status: z.literal("error"), message: z.string() }).strict(),
    ]),
  },
});
