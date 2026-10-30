import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { handleInteractionHttp, runCommandJob, type CommandJob } from "./interactions.js";
import { pollAll } from "./poll.js";
import { repostRandomMemory } from "./repost.js";

/** Leave headroom before Lambda kills the invocation. */
const DEADLINE_BUFFER_MS = 30_000;

type ScheduledJob = { job: "poll" } | { job: "repost" };
type Event = APIGatewayProxyEventV2 | ScheduledJob | CommandJob;

function isHttpEvent(event: Event): event is APIGatewayProxyEventV2 {
  return "requestContext" in event && "http" in (event as APIGatewayProxyEventV2).requestContext;
}

export async function handler(event: Event, context: Context) {
  const deadline = Date.now() + context.getRemainingTimeInMillis() - DEADLINE_BUFFER_MS;

  if (isHttpEvent(event)) {
    return handleInteractionHttp(event);
  }

  switch (event.job) {
    case "poll":
      await pollAll(deadline);
      return;
    case "repost":
      await repostRandomMemory();
      return;
    case "command":
      await runCommandJob(event, deadline);
      return;
    default:
      console.warn("[handler] unrecognised event", JSON.stringify(event).slice(0, 500));
  }
}
