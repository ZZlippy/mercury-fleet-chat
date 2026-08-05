import { interpretWithRules } from "./ruleInterpreter.ts";
import { createAnthropicInterpreter } from "./anthropicInterpreter.ts";
import type { FleetInterpreter } from "./types.ts";

export * from "./types.ts";
export { interpretWithRules, createAnthropicInterpreter };

export function getInterpreter(): FleetInterpreter {
  if (process.env.INTERPRETER === "anthropic") return createAnthropicInterpreter();
  return { name: "rule", interpret: async (text, ctx) => interpretWithRules(text, ctx) };
}
