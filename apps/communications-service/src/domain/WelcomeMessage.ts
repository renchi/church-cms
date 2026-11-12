// The welcome email's words. Domain code, not the email adapter: what we say to a
// new member is a decision of this context, and it shouldn't change when the way
// we send it does (SMTP today, a provider like Resend later).

// ADR-0005's MessageBody value object. Only "plain" for now (ADR-0005's CMS-20 addendum):
// HTML waits until someone asks for a nicer email.
export interface MessageBody {
  content: string;
  format: "plain" | "html";
}

export interface WelcomeMessage {
  subject: string;
  body: MessageBody;
}

export function welcomeMessage(opts: { churchName: string; recipientName: string }): WelcomeMessage {
  const church = opts.churchName.trim();
  const name = opts.recipientName.trim();
  return {
    subject: `Welcome to ${church}, ${name}!`,
    body: {
      format: "plain",
      content: [
        `Dear ${name},`,
        "",
        `Welcome to ${church}! We're glad you've joined us.`,
        "",
        "You'll hear from us about services and events. If you have any questions,",
        "just reply to this email.",
        "",
        `${church}`,
      ].join("\n"),
    },
  };
}
