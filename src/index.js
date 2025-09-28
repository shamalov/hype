import staticHandler from './static';

const TWITCH_IRC_URL = 'https://irc-ws.chat.twitch.tv/';
const USER_TOKEN_KEY = 'twitch:user-token';
const DEFAULT_REDIRECT_URI = 'http://localhost';
const BOT_NICK = 'awesomeeric';
const CHANNELS_DEFAULT = ['kaicenat', 'ishowspeed', 'agent00', 'joe_bartolozzi', 'extraemily'];
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_WINDOW_MS = 5000;
const DEFAULT_THRESHOLD = 20;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/oauth/exchange') {
      return handleCodeExchange(request, env);
    }

    if (url.pathname === '/channels.json') {
      const channels = getConfiguredChannels(env);
      return new Response(JSON.stringify({ channels }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (url.pathname.startsWith('/connect/')) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 400 });
      }
      const channels = getConfiguredChannels(env);
      if (channels.length === 0) {
        return new Response('No channels configured', { status: 500 });
      }
      const allowed = new Set(channels);
      const defaultRoom = channels[0];
      const room = sanitizeRoom(url.pathname.slice('/connect/'.length), defaultRoom);
      if (!room || !allowed.has(room)) {
        return new Response('Unknown channel', { status: 404 });
      }
      const id = env.CHAT_ROOM.idFromName(room);
      const obj = env.CHAT_ROOM.get(id);
      return obj.fetch(request);
    }

    await seedUserTokenIfNeeded(env);
    ctx.waitUntil(ensureTwitchLoop(env));
    return staticHandler.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await seedUserTokenIfNeeded(env);
      await ensureTwitchLoop(env);
    })());
  },
};

async function handleCodeExchange(request, env) {
  const code = new URL(request.url).searchParams.get('code') || await readCodeFromBody(request);
  if (!code) {
    return new Response('missing code', { status: 400 });
  }
  try {
    const record = await exchangeAuthorizationCode(env, code);
    return new Response(JSON.stringify({ ok: true, login: record.login, user_id: record.user_id, scopes: record.scopes }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('OAuth exchange failed', err);
    return new Response(JSON.stringify({ ok: false, error: err.message || String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function ensureTwitchLoop(env) {
  const channels = getConfiguredChannels(env);
  if (channels.length === 0) {
    return;
  }
  await Promise.all(
    channels.map(async (room) => {
      const id = env.CHAT_ROOM.idFromName(room);
      await env.CHAT_ROOM.get(id).fetch(`https://ensure?channel=${room}`, { method: 'POST' });
    })
  );
}

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.twitchPromise = null;
    this.trendState = new Map();
    this.bucketState = new Map();
    this.channel = null;
    this.roomName = null;
    this.allowedChannels = null;
    this.allowedSet = null;
    this.state.waitUntil(seedUserTokenIfNeeded(env));
  }

  setChannel(room) {
    const allowed = this.getAllowedChannels();
    const defaultRoom = allowed[0];
    const slug = sanitizeRoom(room, defaultRoom);
    if (!slug) {
      return false;
    }
    const channel = `#${slug}`;
    if (!this.allowedSet.has(slug)) {
      console.warn('Channel not permitted', channel);
      return false;
    }
    if (this.channel !== channel) {
      this.channel = channel;
      this.roomName = slug;
      this.bucketState = new Map();
      this.trendState = new Map();
    }
    return true;
  }

  getAllowedChannels() {
    if (!this.allowedChannels) {
      const channels = getConfiguredChannels(this.env);
      this.allowedChannels = channels.length ? channels : [...CHANNELS_DEFAULT];
      this.allowedSet = new Set(this.allowedChannels);
    }
    return this.allowedChannels;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = extractRoom(url, this.getAllowedChannels()[0]);
    if (!this.setChannel(room)) {
      return new Response('Unknown channel', { status: 404 });
    }

    const upgrade = request.headers.get('Upgrade');
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      await server.accept();
      this.clients.add(server);
      server.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          this.broadcast({ type: 'client-message', text: event.data, timestamp: Date.now() });
        }
      });
      server.addEventListener('close', () => {
        this.clients.delete(server);
      });
      this.ensureTwitchLoop();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST') {
      await this.ensureTwitchLoop();
      return new Response(null, { status: 204 });
    }

    return new Response('Not Found', { status: 404 });
  }

  async ensureTwitchLoop() {
    if (!this.twitchPromise) {
      const promise = this.runTwitchLoop().catch((err) => {
        console.error('Twitch loop crashed', err);
        this.twitchPromise = null;
      });
      this.twitchPromise = promise;
      this.state.waitUntil(promise);
    }
    return this.twitchPromise;
  }

  async runTwitchLoop() {
    let backoff = MIN_BACKOFF_MS;
    while (true) {
      try {
        await this.connectAndStream();
        backoff = MIN_BACKOFF_MS;
      } catch (err) {
        console.error('Twitch connection failed', err);
        await delay(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async connectAndStream() {
    const accessToken = await ensureUserAccessToken(this.env);
    if (!accessToken) {
      throw new Error('Unable to obtain Twitch access token');
    }

    if (!this.channel) {
      throw new Error('Channel not configured');
    }

    console.log('Connecting to Twitch IRC');
    const response = await fetch(TWITCH_IRC_URL, {
      headers: { Upgrade: 'websocket' },
    });

    if (!response.webSocket) {
      throw new Error('Twitch response did not include a WebSocket');
    }

    const ws = response.webSocket;
    ws.accept();

    ws.send(`PASS oauth:${accessToken}\r\n`);
    ws.send(`NICK ${BOT_NICK}\r\n`);
    ws.send(`JOIN ${this.channel}\r\n`);
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');

    console.log(`Twitch IRC connected as ${BOT_NICK}, joined ${this.channel}`);

    const closePromise = new Promise((resolve) => {
      ws.addEventListener('close', (event) => {
        console.warn('Twitch IRC closed', { code: event.code, reason: event.reason });
        resolve();
      });
    });

    const errorPromise = new Promise((_, reject) => {
      ws.addEventListener('error', (event) => {
        reject(new Error(`WebSocket error: ${event.message || event.type}`));
      });
    });

    ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      this.handleIrcPayload(data, ws).catch((err) => {
        console.error('Failed to handle IRC payload', err);
      });
    });

    await Promise.race([closePromise, errorPromise]);
  }

  async handleIrcPayload(payload, ws) {
    const lines = String(payload).split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;

      if (line.startsWith('PING')) {
        ws.send(line.replace('PING', 'PONG') + '\r\n');
        continue;
      }

      const message = parsePrivmsg(line);
      if (!message) continue;

      if (!this.channel || message.channel.toLowerCase() !== this.channel) {
        continue;
      }

      this.broadcast({
        type: 'twitch-message',
        channel: message.channel,
        user: message.user,
        text: message.message,
        timestamp: Date.now(),
      });

      await registerChatEvent(this, message);
    }
  }

  broadcast(payload) {
    const serialized = JSON.stringify(payload);
    for (const ws of [...this.clients]) {
      try {
        ws.send(serialized);
      } catch (err) {
        console.error('WebSocket send failed, pruning connection', err);
        this.clients.delete(ws);
        try {
          ws.close(1011, 'broadcast failed');
        } catch (_) {}
      }
    }
  }
}

async function ensureUserAccessToken(env) {
  let record = await readStoredToken(env);
  if (record && record.access_token && record.expires_at - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return record.access_token;
  }

  const refreshToken = record?.refresh_token || env.TWITCH_REFRESH_TOKEN;
  if (!refreshToken) {
    console.error('No refresh token available for Twitch user');
    return null;
  }

  record = await refreshUserToken(env, refreshToken);
  return record?.access_token || null;
}

async function readStoredToken(env) {
  try {
    const data = await env.CHAT_KV.get(USER_TOKEN_KEY, { type: 'json' });
    if (data && typeof data === 'object') {
      return data;
    }
  } catch (err) {
    console.error('Failed to read stored Twitch token', err);
  }
  return null;
}

async function refreshUserToken(env, refreshToken) {
  try {
    const params = new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Refresh failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    const validation = await validateToken(data.access_token, env);
    const record = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + (Number(data.expires_in) || 0) * 1000,
      user_id: validation?.user_id || null,
      login: validation?.login || null,
      scopes: normalizeScopes(validation?.scopes || data.scope),
    };

    await env.CHAT_KV.put(USER_TOKEN_KEY, JSON.stringify(record));
    console.log('Stored refreshed Twitch user token', {
      login: record.login,
      user_id: record.user_id,
    });

    return record;
  } catch (err) {
    console.error('Failed to refresh Twitch user token', err);
    return null;
  }
}

async function seedUserTokenIfNeeded(env) {
  if (!env.CHAT_KV) {
    return;
  }

  try {
    const existing = await env.CHAT_KV.get(USER_TOKEN_KEY, { type: 'json' });
    if (existing && existing.access_token && existing.refresh_token) {
      return;
    }
  } catch (err) {
    console.error('Failed to check for existing user token', err);
    return;
  }

  const seedSource = env.SEED_USER_TOKEN;
  if (!seedSource) {
    return;
  }

  try {
    const seed = typeof seedSource === 'string' ? JSON.parse(seedSource) : seedSource;
    if (!seed.access_token || !seed.refresh_token) {
      console.warn('SEED_USER_TOKEN missing access_token or refresh_token');
      return;
    }

    const record = {
      access_token: seed.access_token,
      refresh_token: seed.refresh_token,
      expires_at: seed.expires_at || (Date.now() + 3600 * 1000),
      user_id: seed.user_id || null,
      login: seed.login || null,
      scopes: normalizeScopes(seed.scopes),
    };

    await env.CHAT_KV.put(USER_TOKEN_KEY, JSON.stringify(record));
    console.log('Seeded Twitch user token from SEED_USER_TOKEN');
  } catch (err) {
    console.error('Failed to parse SEED_USER_TOKEN', err);
  }
}

async function validateToken(token, env) {
  try {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` },
    });
    if (!response.ok) {
      const text = await response.text();
      console.error('Token validation failed', text);
      return null;
    }
    return response.json();
  } catch (err) {
    console.error('Token validation error', err);
    return null;
  }
}

async function registerChatEvent(room, parsed) {
  const { env, trendState } = room;
  room.bucketState = room.bucketState || new Map();
  const bucketState = room.bucketState;
  const normalizedChannel = parsed.channel;
  const windowMs = Number(env.HYPE_WINDOW_MS) || DEFAULT_WINDOW_MS;
  const threshold = Number(env.HYPE_THRESHOLD) || DEFAULT_THRESHOLD;
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const channelSlug = normalizedChannel.replace(/^#/, '');
  const key = `${channelSlug}:${bucket}`;
  const ttlMs = Math.max(windowMs * 2, 120_000);

  for (const [existingKey, entry] of bucketState) {
    if (entry.expiresAt <= now) {
      bucketState.delete(existingKey);
    }
  }

  let entry = bucketState.get(key);
  if (!entry) {
    entry = { count: 0, triggered: false, expiresAt: now + ttlMs };
    bucketState.set(key, entry);
  }

  entry.count += 1;
  entry.expiresAt = Math.max(entry.expiresAt, now + ttlMs);

  const trendSnapshot = trackTrends(trendState, channelSlug, parsed.message, now, windowMs);

  if (!entry.triggered && entry.count >= threshold) {
    entry.triggered = true;
    console.log('Hype threshold reached', {
      channel: channelSlug,
      count: entry.count,
      threshold,
      trendTop: trendSnapshot?.top,
    });

    room.broadcast({
      type: 'hype',
      channel: channelSlug,
      count: entry.count,
      threshold,
      trendTop: trendSnapshot?.top,
      timestamp: now,
    });

    if (env.WEBHOOK_URL) {
      await notifyWebhook(env, {
        timestamp: now,
        count: entry.count,
        threshold,
        channel: channelSlug,
        user: parsed.user,
        message: parsed.message,
        trend: trendSnapshot,
      });
    }
  }
}

function trackTrends(trendState, channelSlug, message, now, windowMs) {
  if (!message) {
    return undefined;
  }

  const scopeMs = Math.max(windowMs, 60_000);
  const bucket = Math.floor(now / scopeMs);

  let channelState = trendState.get(channelSlug);
  if (!channelState) {
    channelState = new Map();
    trendState.set(channelSlug, channelState);
  }

  for (const [bucketKey, state] of channelState) {
    if (state.expiresAt <= now) {
      channelState.delete(bucketKey);
    }
  }

  let bucketState = channelState.get(bucket);
  if (!bucketState) {
    bucketState = { counts: new Map(), expiresAt: now + 5 * 60_000 };
    channelState.set(bucket, bucketState);
  } else {
    bucketState.expiresAt = Math.max(bucketState.expiresAt, now + 5 * 60_000);
  }

  const tokens = extractTokens(message);
  for (const token of tokens) {
    const normalized = normalizeToken(token);
    if (!normalized) continue;
    const current = bucketState.counts.get(normalized) || 0;
    bucketState.counts.set(normalized, current + 1);
  }

  const top = [...bucketState.counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([term, count]) => ({ term, count }));

  return { bucket, top };
}

async function notifyWebhook(env, payload) {
  try {
    await fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Failed to post to webhook', err);
  }
}

function normalizeScopes(scopes) {
  if (!scopes) {
    return [];
  }
  if (Array.isArray(scopes)) {
    return scopes
      .filter((scope) => typeof scope === 'string' && scope.length > 0)
      .map((scope) => scope.toLowerCase());
  }
  if (typeof scopes === 'string') {
    return scopes
      .split(/[\s,]+/)
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function parsePrivmsg(rawLine) {
  let line = rawLine;
  let tags = {};

  if (line.startsWith('@')) {
    const spaceIndex = line.indexOf(' ');
    if (spaceIndex !== -1) {
      tags = parseTags(line.slice(1, spaceIndex));
      line = line.slice(spaceIndex + 1);
    }
  }

  if (!line.startsWith(':')) return null;

  const prefixEnd = line.indexOf(' ');
  if (prefixEnd === -1) return null;

  const prefix = line.slice(1, prefixEnd);
  const rest = line.slice(prefixEnd + 1);
  const [commandSection, message = ''] = rest.split(' :');
  const parts = commandSection.split(' ');

  if (parts[0] !== 'PRIVMSG') return null;

  const channel = parts[1];
  const user = tags['display-name'] || prefix.split('!')[0];

  return { user, channel, message, tags };
}

function parseTags(tagString) {
  const tags = {};
  for (const pair of tagString.split(';')) {
    const [key, value = ''] = pair.split('=');
    tags[key] = value.replace(/\\s/g, ' ');
  }
  return tags;
}

function extractTokens(message) {
  return message.toUpperCase().match(/[A-Z0-9]+/g) || [];
}

function normalizeToken(token) {
  if (/^W+$/.test(token)) {
    return token.length === 1 ? 'W' : 'W_STREAK';
  }
  if (/^L+$/.test(token)) {
    return token.length === 1 ? 'L' : 'L_STREAK';
  }
  const tracked = new Set(['W', 'L', 'GG', 'EZ', 'POG', 'HYPE', 'FIRE', 'GOAT', 'CLUTCH']);
  if (tracked.has(token)) {
    return token;
  }
  return undefined;
}

async function readCodeFromBody(request) {
  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const data = await request.json();
      return data.code;
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      return form.get('code');
    }
    return undefined;
  } catch (err) {
    console.error('Failed to read code from body', err);
    return undefined;
  }
}

async function exchangeAuthorizationCode(env, code) {
  const clientId = env.TWITCH_CLIENT_ID;
  const clientSecret = env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing client credentials');
  }

  const redirectUri = env.OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const validation = await validateToken(data.access_token, env);
  if (!validation) {
    throw new Error('Token validation failed');
  }

  const record = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 0) * 1000,
    user_id: validation.user_id || null,
    login: validation.login || null,
    scopes: normalizeScopes(validation.scopes || data.scope),
  };

  await env.CHAT_KV.put(USER_TOKEN_KEY, JSON.stringify(record));
  console.log('Stored user token from authorization code', {
    login: record.login,
    user_id: record.user_id,
  });

  return record;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSlug(value) {
  if (value === undefined || value === null) return null;
  const slug = String(value).trim().toLowerCase().replace(/^#/, '');
  return slug || null;
}

function sanitizeRoom(value, fallback) {
  return sanitizeSlug(value) || fallback || null;
}

function extractRoom(url, fallback) {
  const fromParam = sanitizeSlug(url.searchParams.get('channel'));
  if (fromParam) return fromParam;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return fallback || null;
  return sanitizeSlug(parts[parts.length - 1]) || fallback || null;
}

function getConfiguredChannels(env) {
  const override = env.TOP_TWITCH_CHANNELS;
  if (!override) {
    return [...CHANNELS_DEFAULT];
  }
  const parsed = String(override)
    .split(/[\s,]+/)
    .map(sanitizeSlug)
    .filter(Boolean);
  const unique = Array.from(new Set(parsed));
  return unique.length ? unique : [...CHANNELS_DEFAULT];
}
