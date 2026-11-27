# Local AI gate

Lets the [browser chat](https://tavernworks.dev/local-ai/chat/) and
[Rosin](https://tavernworks.dev/rosin/) reach the FX705 from any device,
through Tailscale Funnel. The devices don't need Tailscale, but they do need
**the laptop key**: the gate only answers browsers that have it (step 4).

The funnel points at this small server, not at Ollama itself. Anyone can
reach a funnel address, and Ollama's own API can also download, copy and
delete models. This server only lets the chat through:

- `GET /api/tags` lists the installed models (names and sizes only).
- `POST /api/chat` streams one reply from an installed model. Only the
  model, the messages, images and a context size go through, all capped. If
  the chat asks for tools, the model only gets the two web tools.
- `GET /search` and `GET /fetch` go to the [web search server](../web-search/)
  on the laptop, so 🌐 works too.
- `GET /health` tells the chat whether Ollama, search, Whisper and the voices are up.
- `GET /api/voices` and `POST /api/speak` give Rosin natural voices: Kokoro,
  in the same speaches server as Whisper (`TTS_URL`, `TTS_MODEL`). Text is
  capped at 1,000 characters a request, and only Kokoro's English voices are
  allowed. Setup: tavernworks.dev/local-ai/#voices
- `GET /api/ics?url=…` reads a calendar's iCal link (https or webcal) for
  Rosin's mood compass, since most calendars don't let a web page read them
  directly. Only public internet addresses: nothing on the laptop, the home
  network or the tailnet. Up to 4 redirects, 3 MB, and it must be a calendar.
  It counts against the search limit.
- Everything except `/health` needs the laptop key, sent as an `X-Gate-Key`
  header. With no key set up, the gate turns every chat away. 20 wrong keys
  from one address lock that address out for 10 minutes.
- Replies keep going on the laptop if the browser drops off (a phone locking,
  a tab put to sleep). The page picks the reply back up with
  `GET /api/reply?id=…&from=N` once it's back; `POST /api/stop?id=…` stops one.
  Replies are kept in memory for 10 minutes after they end.
- Only tavernworks.dev is allowed in from a browser. Each address gets 60
  replies per 10 minutes (400 for everyone together) and 120 searches; at
  most 4 replies wait for the GPU at once.

The Claude Code bridge does **not** go through here. It can run commands on
the laptop, so it stays on the tailnet behind its token.

Needs Node 18 or newer (the laptop has Node 22), no dependencies. All steps
run as **root** on the laptop.

## 1. Copy it to the laptop

```sh
mkdir -p /opt/local-ai-gate
curl -fsSL https://tavernworks.dev/local-ai/gate/server.mjs -o /opt/local-ai-gate/server.mjs
```

## 2. Run it as a service

`/etc/systemd/system/local-ai-gate.service`:

```ini
[Unit]
Description=Local AI gate
After=network-online.target ollama.service local-ai-search.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/local-ai-gate/server.mjs
DynamicUser=yes
LoadCredential=gate-key:/etc/local-ai-gate/key
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now local-ai-gate
curl http://127.0.0.1:8793/health
```

It should say `"ollama":true`, `"keySet":true` (after step 4), and
`"search":true` if the web search server is running. It listens on
`127.0.0.1:8793` only.

## 3. Put it on the funnel

Funnel can only use ports 443, 8443 and 10000. 443 is Ollama on the tailnet
and 8443 is the Verrowen narrator, so the gate gets 10000:

```sh
tailscale funnel --bg --https=10000 http://127.0.0.1:8793
tailscale funnel status
```

From any device, even one not on the tailnet:

```sh
curl https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:10000/health
```

The chat has that address built in (`LAPTOP` near the top of its script). If
the laptop's name ever changes, update it there.

## 4. The laptop key

Make the key once. It's a random 24-character password that only lives in this
file and in the browsers you put it in:

```sh
install -d -m 700 /etc/local-ai-gate
openssl rand -base64 18 | tr '+/' '-_' > /etc/local-ai-gate/key
chmod 600 /etc/local-ai-gate/key
```

If the service was set up before the key existed, add the credential line to it
with a drop-in, then restart:

```sh
mkdir -p /etc/systemd/system/local-ai-gate.service.d
printf '[Service]\nLoadCredential=gate-key:/etc/local-ai-gate/key\n' > /etc/systemd/system/local-ai-gate.service.d/key.conf
systemctl daemon-reload
systemctl restart local-ai-gate
curl -s http://127.0.0.1:8793/health      # "keySet":true
```

Put the key on a device, one of these ways (one device per browser; the chat
and Rosin share it):

- **Type it:** `cat /etc/local-ai-gate/key` shows it. Paste it into the chat's
  ⚙ Settings, Laptop key, or Rosin's ⋯ menu, Laptop key.
- **Key link:** `echo "https://tavernworks.dev/rosin/#key=$(cat /etc/local-ai-gate/key)"`
  and open that link on the device. The key rides after the `#`, which
  browsers never send to tavernworks.dev; the page asks first, saves it, and
  clears it from the address bar.
- **Phone, by QR code:** on a device that already has the key, open the chat's
  ⚙ Settings, tick "Include the laptop key", then Show QR code, and scan it
  with the phone.

To change the key (say a device is lost): run the `openssl` line again,
`systemctl restart local-ai-gate`, and put the new key on your devices.
Anyone with the key can chat with the laptop, so keep it to your own devices.

## Settings

Environment variables, set with `Environment=` in the service file:

| Variable | Default | What it does |
| --- | --- | --- |
| `GATE_MODELS` | every installed model | Only offer these models, comma-separated |
| `GATE_MAX_CTX` | `32768` | Largest context window a chat may ask for |
| `GATE_PORT` | `8793` | Port to listen on |
| `GATE_HOST` | `127.0.0.1` | Address to listen on |
| `GATE_KEY_FILE` | (none) | Read the key from this file instead of the systemd credential |
| `GATE_POOL_URL` | found from `tailscale ip -4`, port 8090 | Where the AI Pool's brain is; `off` hides the pool |
| `GATE_POOL_FALLBACK` | a qwen3 model, else the first | The Ollama model that answers when the pool can't |
| `WHISPER_URL` | `http://127.0.0.1:8000` | The laptop's Whisper server (speaches), for `POST /api/transcribe` |
| `WHISPER_MODEL` | `Systran/faster-distil-whisper-small.en` | Which Whisper model it uses |
| `WHISPER_LANGUAGE` | `en` | The language it listens for |
| `WHISPER_PROMPT` | names like Rosin and Sheamus | A hint that steers how Whisper spells names it would mishear |
| `TTS_URL` | same as `WHISPER_URL` | The speaches server that speaks Rosin's natural voices, for `POST /api/speak` |
| `TTS_MODEL` | `speaches-ai/Kokoro-82M-v1.0-ONNX` | The voice model downloaded into it |
| `GATE_ORIGINS` | `https://tavernworks.dev` | Websites allowed to use it, comma-separated |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama is |
| `SEARCH_URL` | `http://127.0.0.1:8791` | Where the web search server is |

Ollama doesn't need `OLLAMA_ORIGINS` for this: the browser talks to the gate,
and the gate talks to Ollama on the laptop itself.

## Good to know

- **Speech to text for Rosin.** `POST /api/transcribe` takes a short recording
  (webm, ogg, mp4 or wav, up to 12 MB) and returns `{"text": …}` from the laptop's
  Whisper server. Rosin uses it when the browser can't turn speech into text itself.
  `/health` shows `whisper: true` once that server answers.
- **The AI Pool is a model too.** The model lists on the chat and Rosin show
  "AI Pool" (the pool's brain from `pool/m1`, solo or split, on this laptop's
  tailnet address, port 8090). The gate turns the chat into the brain's
  OpenAI-style request and its reply back into Ollama's, web search included.
  If the brain is off, still loading, can't fit the chat or doesn't start
  answering within 5 minutes, an Ollama model answers instead and the reply
  says so. The pool can't see images, so it only gets the text.

- **The laptop has to be awake.** The chat says "Can't reach the laptop" when
  it can't reach the gate.
- **Big models are slow for everyone.** The GPU writes one reply at a time.
  `GATE_MODELS` keeps the list to the ones that run well.
- **Updating:** run step 1's `curl` again, then `systemctl restart local-ai-gate`.
  The pages need this version of the gate: an older gate makes them say it
  "needs its update".
- Logs: `journalctl -u local-ai-gate`.
