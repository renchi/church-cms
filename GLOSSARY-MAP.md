# Glossary Map

Each bounded context has its own language: the same word can mean different things in two contexts, and that's allowed. Its glossary says what a term means *there*.

## Contexts

- [Communications](./apps/communications-service/GLOSSARY.md): talks to members on the church's behalf, starting with the welcome email
- Members (`apps/members-service`): the core domain, the people. Language in [docs/members-service-ddd.md](./docs/members-service-ddd.md) until it gets a glossary
- Events (`apps/events-service`): services, events, attendance and volunteers. Language in [docs/events-service-ddd.md](./docs/events-service-ddd.md) until it gets a glossary

## Relationships

- **Members → Communications**: Members publishes `MemberRegistered` (an id only); Communications reacts with a welcome email and asks Members for the recipient's name and email at send time
- **Members → Events**: Members publishes `MemberArchived`; Events declines that member's volunteer assignments
- **Events → Members**: Events publishes `AttendanceRecorded`; Members keeps an attendance summary

The full map, with the relationship types: [docs/adr/context-map.md](./docs/adr/context-map.md).
