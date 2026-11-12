import { inSpan } from "@cms/events";
import nodemailer, { type Transporter } from "nodemailer";
import type { EmailSender, OutgoingEmail } from "../application/EmailSender.js";

// The email ADAPTER: speaks SMTP, the protocol every mail server understands.
// In the cluster it talks to Mailpit (k8s/mailpit.yaml), a mail server that keeps
// every email in a web inbox instead of delivering it: safe for testing, nobody
// real gets mail. A real provider later (Resend, ADR-0005) is a new adapter
// behind the same EmailSender port; this file and Mailpit would remain for dev.
//
// What "sent" means here: the SMTP server said "250 OK, queued". That's the
// provider ACCEPTING the email, not it reaching an inbox (GLOSSARY.md: sent).
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(opts: { host: string; port: number; from: string }) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      // Mailpit accepts plain SMTP with no login. A real provider needs TLS and
      // credentials, which would come from a Kubernetes Secret, never from values.
      secure: false,
      ignoreTLS: true,
      // Fail within seconds rather than hang: the message isn't acknowledged
      // while we wait, and a failed send is simply retried (nak).
      connectionTimeout: 5_000,
      socketTimeout: 10_000,
    });
    this.from = opts.from;
  }

  async send(email: OutgoingEmail): Promise<void> {
    // A span by hand: nothing instruments nodemailer, and without it the trace
    // would hide where the time goes when the mail server is slow. No recipient
    // address on the span: an email address is personal data (as in the logs).
    await inSpan("smtp send", {}, () =>
      this.transport.sendMail({
        from: this.from,
        to: email.to,
        subject: email.subject,
        // MessageBody's format picks the MIME part: plain text today.
        ...(email.body.format === "html" ? { html: email.body.content } : { text: email.body.content }),
      })
    );
  }
}
