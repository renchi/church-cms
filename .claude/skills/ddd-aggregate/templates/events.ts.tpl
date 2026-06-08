export interface {{Aggregate}}CreatedEvent {
  type: '{{Aggregate}}Created'
  {{aggregate}}Id: string
  occurredAt: Date
}

// TODO: add further events as behaviour is added (e.g. {{Aggregate}}Archived),
// then include them in the union below.
export type {{Aggregate}}DomainEvent = {{Aggregate}}CreatedEvent
