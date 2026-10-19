export interface SseEvent {
  event: string;
  data: string;
}

export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const flush = (): SseEvent | null => {
    if (data.length === 0) {
      event = '';
      return null;
    }
    const out = { event: event || 'message', data: data.join('\n') };
    event = '';
    data = [];
    return out;
  };

  const handleLine = (line: string): SseEvent | null => {
    if (line === '') return flush();
    if (line.startsWith(':')) return null;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return null;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
      if (buffer[nl] === '\r' && nl === buffer.length - 1) break;
      const line = buffer.slice(0, nl);
      const sepLen = buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(nl + sepLen);
      const ev = handleLine(line);
      if (ev) yield ev;
    }
  }
  buffer += decoder.decode();
  // A CR held back at the very end, waiting for a possible LF, is still a line ending.
  if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
  if (buffer) {
    const ev = handleLine(buffer);
    if (ev) yield ev;
  }
  const last = flush();
  if (last) yield last;
}
