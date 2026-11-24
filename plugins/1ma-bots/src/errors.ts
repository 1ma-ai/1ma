import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";

export class BotsError extends experimental_PluginRpcRefusal {
  constructor(code: "forbidden" | "not_found" | "conflict" | "invalid", message: string) {
    super({ code, message });
    this.name = "BotsError";
  }
}
