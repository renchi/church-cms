// The SMTP adapter against a real Mailpit, the same mail server the cluster runs
// (k8s/mailpit.yaml). Sends a welcome email, then reads it back through Mailpit's
// HTTP API, the way the runbook and /verify check the inbox.
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { welcomeMessage } from "../domain/WelcomeMessage.js";
import { SmtpEmailSender } from "./SmtpEmailSender.js";

// Keep in step with k8s/mailpit.yaml and docker-compose.yml.
const MAILPIT_IMAGE = "axllent/mailpit:v1.32.0";

describe("SmtpEmailSender (integration, Mailpit)", () => {
  let mailpit: StartedTestContainer;
  let api: string;

  beforeAll(async () => {
    mailpit = await new GenericContainer(MAILPIT_IMAGE)
      .withExposedPorts(1025, 8025) // SMTP, web UI + API
      .withWaitStrategy(Wait.forHttp("/livez", 8025))
      .start();
    api = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
  }, 120_000);

  afterAll(async () => {
    await mailpit?.stop();
  });

  it("delivers a plain-text welcome email that Mailpit shows in its inbox", async () => {
    const sender = new SmtpEmailSender({
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
      from: "welcome@cms.local",
    });

    await sender.send({
      to: "ana@example.org",
      ...welcomeMessage({ churchName: "Grace Community Church", recipientName: "Ana" }),
    });

    const list = (await (await fetch(`${api}/api/v1/messages`)).json()) as {
      messages: { ID: string; From: { Address: string }; To: { Address: string }[]; Subject: string }[];
    };
    expect(list.messages).toHaveLength(1);
    const [message] = list.messages;
    expect(message.From.Address).toBe("welcome@cms.local");
    expect(message.To.map((t) => t.Address)).toEqual(["ana@example.org"]);
    expect(message.Subject).toBe("Welcome to Grace Community Church, Ana!");

    const full = (await (await fetch(`${api}/api/v1/message/${message.ID}`)).json()) as { Text: string; HTML: string };
    expect(full.Text).toContain("Dear Ana,");
    expect(full.HTML).toBe(""); // plain text only (ADR-0005's CMS-20 addendum)
  });

  it("fails, rather than pretending, when the mail server isn't there", async () => {
    const sender = new SmtpEmailSender({ host: "127.0.0.1", port: 1, from: "welcome@cms.local" });

    await expect(
      sender.send({ to: "x@example.org", subject: "s", body: { content: "b", format: "plain" } })
    ).rejects.toThrow();
  });
});
