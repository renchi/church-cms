import { describe, expect, it } from "vitest";
import { welcomeMessage } from "./WelcomeMessage.js";

describe("welcomeMessage", () => {
  it("greets the member by name, from the church, in plain text", () => {
    const message = welcomeMessage({ churchName: "Grace Community Church", recipientName: "Ana María" });

    expect(message.subject).toBe("Welcome to Grace Community Church, Ana María!");
    expect(message.body.format).toBe("plain");
    expect(message.body.content).toContain("Dear Ana María,");
    expect(message.body.content).toContain("Grace Community Church");
  });

  it("uses the name as Members has it, trimmed", () => {
    const message = welcomeMessage({ churchName: "Grace", recipientName: "  Ana  " });

    expect(message.subject).toBe("Welcome to Grace, Ana!");
  });
});
