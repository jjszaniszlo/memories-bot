import { config } from "../config.js";
import type { Store } from "./types.js";

export * from "./types.js";

let instance: Store | undefined;

/** The configured store. The DynamoDB client (and AWS SDK) only loads if selected. */
export async function getStore(): Promise<Store> {
  if (instance) return instance;
  switch (config.store) {
    case "sqlite": {
      const { createSqliteStore } = await import("./sqlite.js");
      instance = createSqliteStore();
      break;
    }
    case "dynamo": {
      const { createDynamoStore } = await import("./dynamo.js");
      instance = createDynamoStore();
      break;
    }
    default:
      throw new Error(`Unknown STORE "${config.store}" (expected dynamo or sqlite)`);
  }
  return instance;
}

export async function closeStore(): Promise<void> {
  await instance?.close();
  instance = undefined;
}
