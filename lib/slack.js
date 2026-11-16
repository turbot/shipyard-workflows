'use strict';

// A small Slack Web API client over fetch: the one call the announce step makes, a message to
// a channel. The token is sent in a header and never put in a message, so a failure quotes
// Slack's own short error code and nothing else.

class SlackError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

// What Slack answers when it has not taken the message and a second try can work.
const NOT_TAKEN = new Set(['ratelimited', 'service_unavailable']);

function createSlackClient({
  token, apiUrl = 'https://slack.com/api', fetchImpl = globalThis.fetch, timeoutMs = 20000,
} = {}) {
  return {
    // Posts `text` to a channel (a name such as `#releases`, or an ID). Links are not unfurled.
    // A timeout or a dropped connection is an error that is not retryable: the message may have
    // gone out, and a second one would be a second line in the channel.
    async postMessage(channel, text) {
      let res;
      try {
        res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/chat.postMessage`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': 'shipyard',
          },
          body: JSON.stringify({
            channel, text, unfurl_links: false, unfurl_media: false, link_names: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new SlackError(`Slack did not answer chat.postMessage (${e && e.name === 'TimeoutError' ? 'timed out' : 'connection failed'}); the line may or may not have been posted`);
      }
      if (res.status === 429) throw new SlackError('Slack answered 429 to chat.postMessage (rate limited)', { retryable: true });
      if (!res.ok) throw new SlackError(`Slack answered ${res.status} to chat.postMessage`, { retryable: res.status === 503 });
      let answer;
      try {
        answer = await res.json();
      } catch {
        throw new SlackError('Slack answered something that is not JSON to chat.postMessage');
      }
      if (!answer || answer.ok !== true) {
        const code = String((answer && answer.error) || 'unknown_error').replace(/[^a-z0-9_]/gi, '?').slice(0, 60);
        throw new SlackError(`Slack refused the message: ${code}`, { retryable: NOT_TAKEN.has(code) });
      }
      return { ts: String(answer.ts || '') };
    },
  };
}

module.exports = { createSlackClient, SlackError };
