export class Event2 implements Event {
    static readonly NONE = 0 as const;
    static readonly CAPTURING_PHASE = 1 as const;
    static readonly AT_TARGET = 2 as const;
    static readonly BUBBLING_PHASE = 3 as const;
  
    readonly NONE = 0 as const;
    readonly CAPTURING_PHASE = 1 as const;
    readonly AT_TARGET = 2 as const;
    readonly BUBBLING_PHASE = 3 as const;
  
    readonly isTrusted = true;
    readonly timeStamp = Date.now();
  
    public cancelable: boolean;
    public bubbles: boolean;
    public composed: boolean;
    public type: string;
    public target: EventTarget | null = null;
    public defaultPrevented = false;
  
    constructor(
      type: string,
      options: { cancelable?: boolean; bubbles?: boolean; composed?: boolean } = {}
    ) {
      this.type = type;
      this.cancelable = !!options.cancelable;
      this.bubbles = !!options.bubbles;
      this.composed = !!options.composed;
    }
  
    stopImmediatePropagation(): void {}
    preventDefault(): void {
      this.defaultPrevented = true;
    }
    stopPropagation(): void {}
  
    get currentTarget(): EventTarget | null {
      return this.target;
    }
  
    get srcElement(): EventTarget | null {
      return this.target;
    }
  
    composedPath(): EventTarget[] {
      return this.target ? [this.target] : [];
    }
  
    get returnValue(): boolean {
      return !this.defaultPrevented;
    }
  
    get eventPhase(): 0 | 1 | 2 | 3 {
      return this.target ? Event2.AT_TARGET : Event2.NONE;
    }
  
    get cancelBubble(): boolean {
      return false;
    }
  
    set cancelBubble(_: boolean) {
      this.stopPropagation();
    }
  
    initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void {
      this.type = type;
      if (bubbles !== undefined) this.bubbles = bubbles;
      if (cancelable !== undefined) this.cancelable = cancelable;
    }
  }
  

export const EventClass = typeof Event !== 'undefined' ? Event : Event2;
