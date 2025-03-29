import { Event2 } from './Event';

export class ErrorEvent2 extends Event2 implements ErrorEvent {
  readonly colno: number;
  readonly error: any;
  readonly filename: string;
  readonly lineno: number;
  readonly message: string;

  constructor(
    type: string,
    {
      colno = 0,
      error = null,
      filename = '',
      lineno = 0,
      message = '',
    }: ErrorEventInit = {}
  ) {
    super(type);
    this.colno = colno;
    this.error = error;
    this.filename = filename;
    this.lineno = lineno;
    this.message = message;
  }
}

export const ErrorEventClass =
  typeof ErrorEvent !== 'undefined' ? ErrorEvent : ErrorEvent2;
