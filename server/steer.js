// A person's message reaches a working agent without waiting for its step to end by itself (chat.steerAfterMs, see
// docs/ARCHITECTURE.md). The deadline cuts the step only when what still holds it is the calls waiting for sub-agents:
// those go on in the background (their results come as messages), and the notice tells the agent why its calls ended.

export const STEER_NOTICE = '[harness] Ход прерван: человек написал сообщение, и оно не должно ждать конца шага. Вызовы, которые ещё ждали, ты не получил — их работа идёт в фоне, итог придёт сообщением. Сообщение человека — следующим ходом.';

/**
 * The notice of the deadline (the `steer` of a queued message) for the turn started by that message. Only when the
 * deadline really cut the previous turn and the message is still the first of this turn: a turn after a stop the person
 * asked for, or a step that ended by itself, has no `steer`.
 * @param {{ steer?: object, steerAt?: number }} item the first queued item of the turn
 * @param {{ steerAt?: number }} r runtime of the session
 */
export const steerNotice = (item, r) => (!(item?.steer?.cut && r?.steerAt && item.steer.at === r.steerAt) ? ''
  : item.steer.person ? personCutNotice(item.steer.tail, item.steer.by) : STEER_NOTICE);

/**
 * The person cut the step with their message («Сразу агенту»): the CLI's own record may hold a half-written answer and
 * nothing about why it stopped — the agent is told where it was and to go on from there, the message in mind.
 */
export const personCutNotice = (tail, by = 'person') => `[harness] Твой предыдущий ход прерван: ${by === 'report' ? 'пришли сообщения ниже (итог субагента или харнесса)' : 'человек отправил сообщения ниже'}, не дожидаясь конца шага.${tail ? ` Ты остановился на: ${tail}.` : ''} Учти их и продолжай задачу с того места, где остановился, если человек не просит другого.`;
