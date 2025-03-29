import { Event2 } from './Event';

export class MessageEvent2 extends Event2 implements MessageEvent {
  public readonly data: any;
  public readonly origin: string;
  public readonly lastEventId: string;
  public readonly source: MessageEventSource | null;
  public readonly ports: ReadonlyArray<MessagePort>;

  constructor(
    type: string,
    {
      data = null,
      origin = '',
      lastEventId = '',
      source = null,
      ports = [],
    }: MessageEventInit = {}
  ) {
    super(type);
    this.data = data;
    this.origin = origin;
    this.lastEventId = lastEventId;
    this.source = source;
    this.ports = [...ports];
  }

  initMessageEvent(): void {
    throw new Error('Deprecated method');
  }
}

export const MessageEventClass =
  typeof MessageEvent !== 'undefined' ? MessageEvent : MessageEvent2;
