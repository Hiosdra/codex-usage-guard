import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("synthetic repository data", () => {
  test("fixtures do not contain email addresses or home paths", async () => {
    const files = [
      "fixtures/rate-limits-personal.json",
      "fixtures/rate-limits-work.json",
      "docs/codex-integration.md",
      "README.md",
      "prompt.md",
      "example-config.toml",
    ];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      expect(text).not.toMatch(/\/home\/[^/]+/);
      expect(text).not.toMatch(/\/Users\/[^/]+/);
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    }
  });
});
