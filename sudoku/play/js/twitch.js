// Read-only Twitch chat client.
// Connects anonymously ("justinfan" login), the same way the Twitch website
// shows chat to logged-out viewers. No bot account, no OAuth token, and it
// can never post to chat.
window.TwitchChat = (() => {
  const URL = 'wss://irc-ws.chat.twitch.tv:443';

  function parseTags(raw) {
    const tags = {};
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
      tags[k] = v;
    }
    return tags;
  }

  // Parses one IRC line into { tags, prefix, command, params, trailing }.
  function parseLine(line) {
    let rest = line;
    let tags = {};
    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      tags = parseTags(rest.slice(1, sp));
      rest = rest.slice(sp + 1);
    }
    let prefix = '';
    if (rest.startsWith(':')) {
      const sp = rest.indexOf(' ');
      prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }
    let trailing = '';
    const ti = rest.indexOf(' :');
    if (ti !== -1) {
      trailing = rest.slice(ti + 2);
      rest = rest.slice(0, ti);
    }
    const [command, ...params] = rest.split(' ');
    return { tags, prefix, command, params, trailing };
  }

  /**
   * connect(channel, { onMessage(msg), onStatus(state, detail) })
   * msg = { user, displayName, color, isMod, isBroadcaster, text }
   */
  function connect(channel, handlers) {
    channel = channel.toLowerCase().replace(/^#/, '').trim();
    let ws = null;
    let retry = 0;
    let closedByUs = false;

    const status = (s, d) => handlers.onStatus && handlers.onStatus(s, d);

    function open() {
      status('connecting');
      ws = new WebSocket(URL);
      ws.onopen = () => {
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send('PASS SCHMOOPIIE');
        ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 80000));
        ws.send('JOIN #' + channel);
      };
      ws.onmessage = (ev) => {
        for (const line of ev.data.split('\r\n')) {
          if (!line) continue;
          if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
          const m = parseLine(line);
          if (m.command === 'JOIN') { retry = 0; status('connected', channel); }
          else if (m.command === 'RECONNECT') { ws.close(); }
          else if (m.command === 'PRIVMSG') {
            const login = m.prefix.split('!')[0];
            const badges = m.tags.badges || '';
            handlers.onMessage({
              user: login,
              displayName: m.tags['display-name'] || login,
              color: m.tags.color || '',
              isBroadcaster: /(^|,)broadcaster\//.test(badges),
              isMod: m.tags.mod === '1' || /(^|,)moderator\//.test(badges),
              text: m.trailing,
            });
          }
        }
      };
      ws.onclose = () => {
        if (closedByUs) return;
        const delay = Math.min(30000, 1000 * 2 ** retry++);
        status('disconnected', `retrying in ${Math.round(delay / 1000)}s`);
        setTimeout(open, delay);
      };
      ws.onerror = () => {};
    }

    open();
    return { close() { closedByUs = true; ws && ws.close(); } };
  }

  return { connect, parseLine };
})();
