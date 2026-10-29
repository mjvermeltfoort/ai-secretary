export interface OpenQuestion { id: string; question: string; evidence: string; }
export interface Assessment { questions: OpenQuestion[]; transition: boolean; }
export interface KneutInput {
  text: string;
  turns: Array<{ id: number; text: string }>;
  incomplete: boolean;
  recording: boolean;
  live: boolean;
  lastSpeechAt: number;
  lastFrameAt: number;
  voiceBusy: boolean;
  manualDialogue: boolean;
}
interface Options {
  getInput: () => KneutInput;
  assess: (text: string) => Promise<Assessment>;
  speak: (text: string, stillAllowed: () => boolean) => Promise<boolean>;
  interrupt: () => void;
  onChange: (state: KneutState) => void;
  now?: () => number;
  initial?: KneutState;
}
export interface KneutState { questions: OpenQuestion[]; deferred: boolean; listening: boolean; error?: string; askedIds?: string[]; lastIntervention?: number; }
export function addressKneut(text: string): string | undefined {
  const match = text.trim().match(/^(?:(?:h[eé]y|hoi|zeg|ok[eé])[,!\s]+)?kneut\b[\s,:;.!?]*(.*)$/iu);
  return match ? match[1].trim() : undefined;
}
export function isTopicTransition(text: string): boolean {
  const tail = text.slice(-250).trim();
  return /(?:akkoord|afgesproken|besloten|dat is (?:duidelijk|geregeld)|dan gaan we|gaan we door|goed|prima)[\s\S]{0,65}(?:volgende (?:punt|onderwerp|agendapunt)|verder met)[^.!?]{0,70}[.!?]?$/iu.test(tail)
    && !/\b(?:maar|misschien|toch|wacht|hoe|waarom|of niet)\b/iu.test(tail.slice(-100));
}

// Silence is necessary, never sufficient, for an unsolicited question.
export class KneutController {
  private state: KneutState = { questions: [], deferred: false, listening: false };
  private seen = new Set<number>();
  private pending?: { text: string; since: number; bare?: boolean };
  private awaitingQuestionUntil = 0;
  private assessmentText = "";
  private transition = false;
  private requestedAt = -Infinity;
  private busy = false;
  private speaking = false;
  private lastIntervention = -Infinity;
  private asked = new Set<string>();
  private disposed = false;
  private epoch = 0;
  constructor(private readonly options: Options) {
    if (options.initial) {
      this.state = { ...options.initial, listening: false };
      this.asked = new Set(options.initial.askedIds ?? []);
      this.lastIntervention = options.initial.lastIntervention ?? -Infinity;
    }
    options.getInput().turns.forEach(t => this.seen.add(t.id));
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private emit(update: Partial<KneutState>) {
    if (Object.entries(update).every(([key, value]) => this.state[key as keyof KneutState] === value)) return;
    this.state = { ...this.state, ...update }; this.options.onChange(this.state);
  }
  defer(value: boolean) { this.emit({ deferred: value }); }
  dispose() { this.disposed = true; ++this.epoch; this.pending = undefined; }
  private quiet(input: KneutInput, milliseconds: number) {
    return input.recording && input.live && !input.incomplete && !input.manualDialogue
      && this.now() - input.lastFrameAt < 1500 && this.now() - input.lastSpeechAt >= milliseconds;
  }
  tick(): void {
    if (this.disposed) return;
    const input = this.options.getInput();
    if (!input.recording || !input.live) {
      ++this.epoch; this.pending = undefined; this.awaitingQuestionUntil = 0; this.emit({ listening: false });
      // Never replay wake words from an offline gap or a previous session.
      input.turns.forEach(t => this.seen.add(t.id));
      return;
    }
    if (input.voiceBusy && this.now() - input.lastSpeechAt < 250) this.options.interrupt();
    for (const turn of input.turns) {
      if (this.seen.has(turn.id)) continue;
      this.seen.add(turn.id);
      if (input.manualDialogue) continue;
      const addressed = addressKneut(turn.text);
      if (addressed !== undefined) {
        if (/bewaar.*vragen.*(?:eind|later)|(?:stel|bewaar).*vragen.*uit/iu.test(addressed)) {
          this.defer(true); this.pending = { text: "Bevestig kort: ik bewaar mijn vragen tot het einde.", since: this.now() };
        } else if (/wat (?:staat|is|zijn).*open|welke vragen.*(?:nog|open)/iu.test(addressed)) {
          this.pending = { text: `Lees de open verduidelijkingsvragen kort voor, zonder antwoorden te verzinnen: ${JSON.stringify(this.state.questions)}`, since: this.now() };
        } else {
          this.pending = { text: addressed || "Zeg alleen: Ja?", since: this.now(), bare: !addressed };
        }
        this.emit({ listening: true });
      } else if (this.pending) {
        this.pending.text += `\nVervolg van de vraag: ${turn.text}`;
        this.pending.bare = false;
      } else if (this.now() < this.awaitingQuestionUntil) {
        this.awaitingQuestionUntil = 0;
        this.pending = { text: turn.text, since: this.now() };
        this.emit({ listening: true });
      }
    }
    if (this.pending && this.now() - this.pending.since > 60000) { this.pending = undefined; this.emit({ listening: false }); }
    if (this.pending && !this.speaking && !input.voiceBusy && this.quiet(input, 1800)) {
      const pending = this.pending;
      this.dispatch(pending.text, () => this.pending === pending && this.quiet(this.options.getInput(), 1800), () => {
        this.awaitingQuestionUntil = pending.bare ? this.now() + 15000 : 0;
        this.pending = undefined; this.emit({ listening: false });
      });
      return;
    }
    if (!input.manualDialogue && !input.voiceBusy && input.text.trim() && !input.incomplete && input.text !== this.assessmentText && !this.busy && this.now() - this.requestedAt >= 12000) {
      this.busy = true; this.requestedAt = this.now();
      const text = input.text; const epoch = this.epoch;
      void this.options.assess(text).then(result => {
        if (this.disposed || epoch !== this.epoch || this.options.getInput().text !== text || !this.options.getInput().recording) return;
        this.assessmentText = text; this.transition = result.transition;
        this.emit({ questions: result.questions, error: undefined });
      }).catch(() => { if (!this.disposed && epoch === this.epoch) this.emit({ error: "Open vragen tijdelijk niet bijgewerkt. De opname loopt door." }); })
        .finally(() => { this.busy = false; });
    }
    const candidate = this.state.questions.find(q => !this.asked.has(q.id));
    const mayAsk = () => {
      const current = this.options.getInput();
      return !this.state.deferred && !this.pending && !current.voiceBusy && this.quiet(current, 3000)
        && current.text === this.assessmentText && this.transition && isTopicTransition(current.text)
        && this.now() - this.lastIntervention >= 120000;
    };
    if (candidate && !this.speaking && mayAsk()) {
      this.dispatch(`Stel uitsluitend deze verduidelijkingsvraag, zonder inleiding: ${candidate.question}`, mayAsk, () => {
        this.asked.add(candidate.id); this.lastIntervention = this.now();
        this.emit({ askedIds: [...this.asked], lastIntervention: this.lastIntervention });
      });
    }
  }
  private dispatch(text: string, allowed: () => boolean, sent: () => void) {
    const epoch = this.epoch;
    this.speaking = true;
    void this.options.speak(text, () => !this.disposed && epoch === this.epoch && allowed()).then(ok => {
      if (ok && !this.disposed && epoch === this.epoch) sent();
    }).catch(() => { if (!this.disposed) this.emit({ error: "Kneut kon niet spreken. Je kunt de gespreksknop gebruiken." }); })
      .finally(() => { this.speaking = false; });
  }
}
