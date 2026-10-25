import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("drops query strings and redacts secrets", () => {
    const lines: string[] = [];
    const logger = createLogger("info", { write: (line: string) => lines.push(line) });
    logger.info({ req: { method: "GET", url: "/api/integrations/google/callback?code=SECRET-CODE&state=SECRET-STATE" } }, "request");
    logger.info({ session: { token: "SECRET-TOKEN" } }, "session");
    const output = lines.join("");
    expect(output).toContain("/api/integrations/google/callback");
    expect(output).not.toMatch(/SECRET-(CODE|STATE|TOKEN)/);
  });
});
