export type KneutMode = "idle" | "listening" | "thinking" | "speaking" | "paused" | "waiting" | "muted" | "error";

/** Two aligned illustrations, animated locally; no video service or additional audio capture. */
export function KneutCharacter({ mode, large = false }: { mode: KneutMode; large?: boolean }) {
  return <div className={`kneut-character${large ? " kneut-character-large" : ""}`} data-mode={mode} aria-hidden="true">
    <div className="kneut-character-motion">
      <img className="kneut-frame kneut-frame-rest" src="/kneut/listening.webp" width="768" height="1152" alt="" draggable={false} />
      <img className="kneut-frame kneut-frame-talk" src="/kneut/speaking.webp" width="768" height="1152" alt="" draggable={false} />
    </div>
  </div>;
}
