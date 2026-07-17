import { LlmExtractionError } from "./errors.js";

export interface ChunkingConfiguration {
  maxChunkCharacters: number;
  maxChunks: number;
}

export function splitIntoBoundedChunks(
  text: string,
  configuration: ChunkingConfiguration,
): string[] {
  if (text.trim() === "") {
    return [];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (chunks.length >= configuration.maxChunks) {
      throw new LlmExtractionError(
        "LLM_CONTENT_LIMIT_EXCEEDED",
        `Source requires more than ${configuration.maxChunks} LLM chunks`,
        { retryable: false },
      );
    }

    const hardEnd = Math.min(
      text.length,
      cursor + configuration.maxChunkCharacters,
    );
    let end = hardEnd;
    if (hardEnd < text.length) {
      const newline = text.lastIndexOf("\n", hardEnd);
      if (newline > cursor + Math.floor(configuration.maxChunkCharacters / 2)) {
        end = newline;
      }
    }
    const chunk = text.slice(cursor, end).trim();
    if (chunk !== "") {
      chunks.push(chunk);
    }
    cursor = end;
    while (text[cursor] === "\n" || text[cursor] === "\r") {
      cursor += 1;
    }
  }
  return chunks;
}
