// Validates incoming events and turns them into Conversions API event objects.

import { randomUUID } from 'node:crypto';
import { normalizeUserData } from './normalize.js';

export const MAX_EVENT_AGE_SECONDS = 7 * 24 * 3600; // Meta rejects events older than 7 days
const MAX_FUTURE_SKEW_SECONDS = 300;

const ACTION_SOURCES = new Set([
  'website', 'app', 'email', 'phone_call', 'chat', 'physical_store',
  'system_generated', 'business_messaging', 'other',
]);

const STANDARD_EVENTS = new Set([
  'AddPaymentInfo', 'AddToCart', 'AddToWishlist', 'CompleteRegistration', 'Contact',
  'CustomizeProduct', 'Donate', 'FindLocation', 'InitiateCheckout', 'Lead', 'PageView',
  'Purchase', 'Schedule', 'Search', 'StartTrial', 'SubmitApplication', 'Subscribe', 'ViewContent',
]);

export class EventError extends Error {}

function cleanUrl(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.toString().slice(0, 2048);
  } catch {
    return undefined;
  }
}

function cleanCustomData(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw new EventError('custom_data must be an object');
  const out = { ...input };
  if (out.value !== undefined) {
    const n = Number(out.value);
    if (!Number.isFinite(n)) throw new EventError('custom_data.value must be a number');
    out.value = n;
  }
  if (out.currency !== undefined) {
    const c = String(out.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new EventError('custom_data.currency must be a 3-letter ISO code');
    out.currency = c;
  }
  if (JSON.stringify(out).length > 8192) throw new EventError('custom_data is too large (8 KB max)');
  return Object.keys(out).length ? out : undefined;
}

export function isStandardEvent(name) {
  return STANDARD_EVENTS.has(name);
}

/**
 * Builds a Conversions API event.
 * @param {object} input   raw event from the browser snippet or a server caller
 * @param {object} ctx     { source: 'browser'|'server', ip, userAgent, cookies, config, now }
 * @returns {{ consent: boolean, event: object }}
 */
export function buildEvent(input, ctx) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EventError('event must be a JSON object');
  const { config } = ctx;
  const now = ctx.now ?? Math.floor(Date.now() / 1000);

  const consent = input.consent === true;

  const eventName = typeof input.event_name === 'string' ? input.event_name.trim() : '';
  if (!/^[A-Za-z0-9_ -]{1,64}$/.test(eventName)) throw new EventError('event_name is required (letters, digits, _ - space, max 64)');

  let eventId = input.event_id;
  if (eventId !== undefined && eventId !== null && eventId !== '') {
    eventId = String(eventId);
    if (eventId.length > 128) throw new EventError('event_id is too long (128 max)');
  } else {
    eventId = randomUUID();
  }

  let eventTime = now;
  if (input.event_time !== undefined && input.event_time !== null) {
    eventTime = Number(input.event_time);
    if (!Number.isInteger(eventTime)) throw new EventError('event_time must be a Unix timestamp in seconds');
    if (eventTime < now - MAX_EVENT_AGE_SECONDS + 60) throw new EventError('event_time is older than 7 days; Meta would reject it');
    if (eventTime > now + MAX_FUTURE_SKEW_SECONDS) throw new EventError('event_time is in the future');
  }

  let actionSource = 'website';
  if (ctx.source === 'server' && input.action_source !== undefined) {
    actionSource = String(input.action_source);
    if (!ACTION_SOURCES.has(actionSource)) throw new EventError(`action_source must be one of: ${[...ACTION_SOURCES].join(', ')}`);
  }

  const rawUser = { ...(input.user_data && typeof input.user_data === 'object' ? input.user_data : {}) };
  // Browser events: network identifiers come from the request itself, never from the payload.
  if (ctx.source === 'browser') {
    rawUser.client_ip_address = ctx.ip;
    rawUser.client_user_agent = ctx.userAgent;
    rawUser.fbp = input.fbp || ctx.cookies?._fbp || undefined;
    rawUser.fbc = input.fbc || ctx.cookies?._fbc || undefined;
  }
  const userData = normalizeUserData(rawUser, { defaultPhoneCountryCode: config.defaultPhoneCountryCode });
  if (Object.keys(userData).length === 0) throw new EventError('user_data needs at least one identifier (client_ip_address + client_user_agent, em, ph, fbp, ...)');

  const event = {
    event_name: eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: actionSource,
    user_data: userData,
  };

  const sourceUrl = cleanUrl(input.event_source_url);
  if (sourceUrl) event.event_source_url = sourceUrl;
  else if (actionSource === 'website') throw new EventError('event_source_url is required for website events');

  const customData = cleanCustomData(input.custom_data);
  if (customData) event.custom_data = customData;

  if (Array.isArray(input.data_processing_options)) {
    event.data_processing_options = input.data_processing_options.filter((o) => o === 'LDU');
    if (input.data_processing_options_country !== undefined) event.data_processing_options_country = Number(input.data_processing_options_country) || 0;
    if (input.data_processing_options_state !== undefined) event.data_processing_options_state = Number(input.data_processing_options_state) || 0;
  }

  return { consent, event };
}
