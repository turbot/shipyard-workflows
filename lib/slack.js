'use strict';

// A small Slack Web API client over fetch: the one call the announce step and the approver
// ask make (a message to a channel, or a reply in a thread). The
// token is sent in a header and never put in a message or an error, so a failure quotes Slack's
// own short error code and nothing else.

class SlackError extends Error {
  constructor(message, { retryable = false, code } = {}) {
    super(message);
    this.retryable = retryable;
    if (code) this.code = code;
  }
}

// What Slack answers when it has not taken the message and a second try can work.
const NOT_TAKEN = new Set(['ratelimited', 'service_unavailable']);

function createSlackClient({
  token, apiUrl = 'https://slack.com/api', fetchImpl = globalThis.fetch, timeoutMs = 20000,
} = {}) {
  // One call: `body` is the request body and `type` its content type. A timeout or a dropped
  // connection is an error that is not retryable: a message may have gone out, and a second one
  // would be a second line in the channel.
  async function call(method, { body, type, posts }) {
    let res;
    try {
      res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'User-Agent': 'shipyard' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new SlackError(`Slack did not answer ${method} (${e && e.name === 'TimeoutError' ? 'timed out' : 'connection failed'})${posts ? '; the line may or may not have been posted' : ''}`);
    }
    if (res.status === 429) throw new SlackError(`Slack answered 429 to ${method} (rate limited)`, { retryable: posts });
    if (!res.ok) throw new SlackError(`Slack answered ${res.status} to ${method}`, { retryable: posts && res.status === 503 });
    let answer;
    try {
      answer = await res.json();
    } catch {
      throw new SlackError(`Slack answered something that is not JSON to ${method}`);
    }
    if (!answer || answer.ok !== true) {
      // Slack's error is a short code such as `channel_not_found`; nothing else is echoed.
      const code = String((answer && answer.error) || 'unknown_error').replace(/[^a-z0-9_]/gi, '?').slice(0, 60);
      throw new SlackError(`Slack refused ${method === 'chat.postMessage' ? 'the message' : method}: ${code}`, { retryable: posts && NOT_TAKEN.has(code), code });
    }
    return answer;
  }

  return {
    // Posts `text` to a channel (a name such as `#releases`, or an ID), as a reply in a thread when
    // `threadTs` is given. With `blocks` (Block Kit), Slack shows them and keeps `text` as the
    // fallback for a notification. Links are not unfurled. Returns `{ channel, ts }`: the channel's ID.
    async postMessage(channel, text, { threadTs, blocks } = {}) {
      const answer = await call('chat.postMessage', {
        posts: true,
        type: 'application/json; charset=utf-8',
        body: JSON.stringify({
          channel, text, ...(blocks ? { blocks } : {}), unfurl_links: false, unfurl_media: false, link_names: false, ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      });
      return { channel: String(answer.channel || ''), ts: String(answer.ts || '') };
    },
  };
}

module.exports = { createSlackClient, SlackError };
