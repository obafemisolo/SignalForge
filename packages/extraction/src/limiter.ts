interface DomainState {
  semaphore: Semaphore;
  minimumDelayMs: number;
  nextStartAt: number;
  startBarrier: Promise<void>;
}

export class RequestLimiter {
  private readonly globalSemaphore: Semaphore;
  private readonly domains = new Map<string, DomainState>();

  public constructor(
    globalConcurrency: number,
    private readonly domainConcurrency: number,
    private readonly defaultDomainDelayMs: number,
  ) {
    this.globalSemaphore = new Semaphore(globalConcurrency);
  }

  public setMinimumDomainDelay(domain: string, delayMs: number): void {
    const state = this.getDomainState(domain);
    state.minimumDelayMs = Math.max(state.minimumDelayMs, delayMs);
  }

  public async schedule<T>(
    domain: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const state = this.getDomainState(domain);
    const releaseDomain = await state.semaphore.acquire();
    try {
      await this.waitForDomainStart(state);
      const releaseGlobal = await this.globalSemaphore.acquire();
      try {
        return await operation();
      } finally {
        releaseGlobal();
      }
    } finally {
      releaseDomain();
    }
  }

  private getDomainState(domain: string): DomainState {
    const key = domain.toLowerCase();
    const existing = this.domains.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: DomainState = {
      semaphore: new Semaphore(this.domainConcurrency),
      minimumDelayMs: this.defaultDomainDelayMs,
      nextStartAt: 0,
      startBarrier: Promise.resolve(),
    };
    this.domains.set(key, created);
    return created;
  }

  private async waitForDomainStart(state: DomainState): Promise<void> {
    const previous = state.startBarrier;
    let releaseBarrier: (() => void) | undefined;
    state.startBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    await previous;
    try {
      const delay = Math.max(0, state.nextStartAt - Date.now());
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      state.nextStartAt = Date.now() + state.minimumDelayMs;
    } finally {
      releaseBarrier?.();
    }
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  public constructor(private readonly capacity: number) {}

  public async acquire(): Promise<() => void> {
    if (this.active >= this.capacity) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}
