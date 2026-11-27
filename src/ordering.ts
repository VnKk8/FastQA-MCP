/** The part of an MCP transport this module needs (the SDK's stdio transport fits). */
export interface OrderableTransport {
  onmessage?: (message: any, extra?: any) => void;
  send(message: any, options?: any): Promise<void>;
}

/** Tool calls that may wait for their turn. A client that sends more than this without reading answers gets an error. */
export const MAX_WAITING_CALLS = 1000;

/**
 * Hands `tools/call` requests to the server one at a time, in the order they arrived.
 *
 * The SDK validates the arguments of a call asynchronously before it runs the tool. When several calls arrive in one
 * read, a call with a small schema (snapshot) finishes validating first and would run ahead of calls that arrived
 * before it (act). Here the next call is handed over only when the previous one has been answered or cancelled, so
 * arrival order is execution order. Everything else (initialize, tools/list, pings, notifications) passes straight
 * through. Call it after `server.connect(transport)`.
 */
export function inArrivalOrder(transport: OrderableTransport, maxWaiting = MAX_WAITING_CALLS): void {
  const deliver = transport.onmessage;
  if (!deliver) throw new Error('inArrivalOrder: connect the server to the transport first');
  const send = transport.send.bind(transport);
  const waiting: { message: any; extra: any }[] = [];
  let busy: { id: string | number } | undefined;

  const start = (w: { message: any; extra: any }) => {
    busy = { id: w.message.id };
    try { deliver(w.message, w.extra); } catch (e) { next(); throw e; }
  };
  function next() {
    busy = undefined;
    const w = waiting.shift();
    if (w) start(w);
  }

  transport.onmessage = (message, extra) => {
    if (message?.method === 'tools/call' && message.id !== undefined && message.id !== null) {
      if (!busy) start({ message, extra });
      else if (waiting.length < maxWaiting) waiting.push({ message, extra });
      else void send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `Too many tool calls are waiting (limit ${maxWaiting}). Wait for answers before sending more.` } }).catch(() => undefined);
      return;
    }
    if (message?.method === 'notifications/cancelled') {
      const id = message.params?.requestId;
      const i = waiting.findIndex((w) => w.message.id === id);
      if (i >= 0) { waiting.splice(i, 1); return; } // cancelled before its turn: it never runs and needs no answer
      deliver(message, extra);
      if (busy && busy.id === id) next(); // the SDK sends no answer for a cancelled request, so its turn ends here
      return;
    }
    deliver(message, extra);
  };

  transport.send = async (message, options) => {
    try { await send(message, options); }
    finally {
      if (busy && message && message.id === busy.id && ('result' in message || 'error' in message)) next();
    }
  };
}
