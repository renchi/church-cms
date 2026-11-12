# Communications

The supporting context that talks to members on the church's behalf. It never owns person data: it asks Members for a name and an email address when it is about to send something.

## Language

### Messages

**Welcome email**:
The one email a member receives because they registered. At most one per member, ever.
_Avoid_: Welcome message, onboarding email, registration confirmation

**Transactional message**:
A message to one person, caused by something that person did (registering). A welcome email is one.
_Avoid_: Notification, one-off campaign

**Campaign**:
A broadcast to a group of members that an admin writes and sends (ADR-0005's `MessageCampaign`). Never used for a welcome email.
_Avoid_: Blast, mailing, newsletter

### Outcomes

**Sent**:
The email provider accepted the welcome email for delivery. Says nothing about whether it reached the inbox.
_Avoid_: Delivered, received

**Skipped**:
The member was already archived when Communications came to send the welcome email, so none was sent, on purpose.
_Avoid_: Failed, cancelled, ignored

### People

**Recipient**:
A member as Communications sees them at send time: id, name and email, looked up from Members and never stored.
_Avoid_: Contact, subscriber, user

**Recipient resolver**:
Communications' way of asking Members who someone is, at the moment of sending: for one member, or for a group of them.
_Avoid_: Member lookup, address book, directory
