// The on-screen action caption overlay (Buckshot-style), shown low-centre.
//
// Captions are QUEUED and typed out one character at a time at a fixed cadence
// (a "typewriter"), firing a blip callback as each glyph appears. This makes
// every turn/action narrate itself with synced text + sound, then the next
// queued caption follows. Presentation only.

export interface CaptionItem {
  readonly title: string;
  readonly desc: string;
}

const CHAR_MS = 34; // fixed time per character (the "exact time")
const BLIP_EVERY = 2; // play a blip every N characters (avoids audio spam)
const HOLD_MS = 1300; // how long a fully-typed caption lingers before the next

export class CaptionView {
  private readonly root: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly descEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly onBlip: () => void;
  private readonly onStop: () => void;

  private readonly queue: CaptionItem[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentItem: CaptionItem | null = null;
  private isFinishedAnimating = false;

  public onIdle: () => void = () => {};

  public get isIdle(): boolean {
    return !this.running;
  }

  constructor(onBlip: () => void = () => {}, onStop: () => void = () => {}) {
    this.onBlip = onBlip;
    this.onStop = onStop;
    this.root = document.createElement("div");
    this.root.className = "rr-caption";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "rr-caption-title";
    this.descEl = document.createElement("div");
    this.descEl.className = "rr-caption-desc";
    this.root.append(this.titleEl, this.descEl);

    // A separate, instant hint line (item hover descriptions) — no typewriter.
    this.hintEl = document.createElement("div");
    this.hintEl.className = "rr-hint";
  }

  mount(host: HTMLElement): void {
    host.appendChild(this.root);
    // Hint goes directly on body so it's never clipped by canvas z-stacking.
    document.body.appendChild(this.hintEl);
  }

  private hintTimer: ReturnType<typeof setTimeout> | undefined;

  /** Show an instant hover hint (e.g. an item description). Auto-hides after 3s. */
  showHint(title: string, desc: string): void {
    this.hintEl.innerHTML =
      `<span class="rr-hint-title">${title}</span>` +
      `<span class="rr-hint-desc">${desc}</span>`;
    this.hintEl.classList.add("rr-hint-on");
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.clearHint(), 3000);
  }

  /** Hide the hover hint instantly. */
  clearHint(): void {
    this.hintEl.classList.remove("rr-hint-on");
    if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = undefined; }
  }

  /** Queue a caption to be typed out after any currently-playing one. */
  enqueue(title: string, desc: string): void {
    this.queue.push({ title, desc });
    if (!this.running) this.advance();
  }

  // -- internals ------------------------------------------------------------

  private advance(): void {
    if (this.timer) clearTimeout(this.timer);
    const item = this.queue.shift();
    this.currentItem = item ?? null;
    this.isFinishedAnimating = false;
    
    if (!item) {
      this.running = false;
      this.onStop(); // typing fully done — cut the blip sound
      this.root.classList.remove("rr-caption-on");
      this.onIdle();
      return;
    }
    this.running = true;
    this.typeOut(item);
  }

  /** Type the title, then the description, blipping as characters appear. */
  private typeOut(item: CaptionItem): void {
    this.root.classList.add("rr-caption-on");
    this.titleEl.textContent = "";
    this.descEl.textContent = "";

    const title = item.title;
    const desc = item.desc;
    let i = 0; // index into the title
    let j = 0; // index into the description

    const stepTitle = (): void => {
      i++;
      this.titleEl.textContent = title.slice(0, i);
      if (i % BLIP_EVERY === 0) this.onBlip();
      if (i < title.length) {
        this.timer = setTimeout(stepTitle, CHAR_MS);
      } else {
        this.timer = setTimeout(stepDesc, CHAR_MS * 4);
      }
    };

    const stepDesc = (): void => {
      j++;
      this.descEl.textContent = desc.slice(0, j);
      if (j % BLIP_EVERY === 0) this.onBlip();
      if (j < desc.length) {
        this.timer = setTimeout(stepDesc, CHAR_MS);
      } else {
        // Finished animating this caption — stop the blip, then linger.
        this.onStop();
        this.isFinishedAnimating = true;
        this.timer = setTimeout(() => this.advance(), HOLD_MS);
      }
    };

    if (title.length > 0) stepTitle();
    else stepDesc();
  }

  /** Skip the typewriter animation or move to the next caption immediately. */
  skipCurrent(): void {
    if (!this.running || !this.currentItem) return;

    if (this.timer) clearTimeout(this.timer);

    if (!this.isFinishedAnimating) {
      // Instantly finish typing the current item
      this.isFinishedAnimating = true;
      this.titleEl.textContent = this.currentItem.title;
      this.descEl.textContent = this.currentItem.desc;
      this.onStop();
      // Start the linger timer, which can be skipped by a second click
      this.timer = setTimeout(() => this.advance(), HOLD_MS);
    } else {
      // Already finished typing, skip the linger time and move on
      this.advance();
    }
  }
}
