import type { MessageBody } from "../domain/WelcomeMessage.js";

// A PORT: what the use case needs ("send this email"), with no word about how.
// Today's ADAPTER speaks SMTP to Mailpit (infrastructure/SmtpEmailSender.ts). A
// real provider (Resend, ADR-0005's deferred list) would be another adapter
// behind the same interface: the use case and its tests wouldn't change. That's
// "ports and adapters" (hexagonal architecture), study-guide §16.
export interface OutgoingEmail {
  to: string;
  subject: string;
  body: MessageBody;
}

export interface EmailSender {
  // Resolves once the provider has ACCEPTED the email ("sent" in GLOSSARY.md),
  // not once it's in the inbox: nobody can promise that. Throws on failure.
  send(email: OutgoingEmail): Promise<void>;
}
