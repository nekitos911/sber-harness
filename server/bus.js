// Broadcast channel to WebSocket clients. Every event is a WS frame object ({ t: 'task', task }, ...).
import { EventEmitter } from 'node:events';

export function createBus() {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
  return {
    send: (frame) => ee.emit('frame', frame),
    subscribe(fn) {
      ee.on('frame', fn);
      return () => ee.off('frame', fn);
    },
  };
}
