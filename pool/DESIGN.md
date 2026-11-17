# AI Pool — design (2026-11-15)

Goal: one model split across all pooled PCs (distributed inference), so Shea
can run models past the ~4b-per-PC limit he's at now (phi4-mini 3.8b /
gemma3:4b). A webpage enrolls PCs into the pool; Shea picks a model; the
bots talk to one address and the pool serves it.

## How the split actually works (llama.cpp RPC — verified 2026-11-15)

- Every PC runs one small worker: `ggml-rpc-server` from llama.cpp. It
  offers that PC's GPU/CPU to the pool; how much memory it carries is
  set by the host's tensor-split (the v1.0.0 rpc-server has no memory
  flag of its own — noted during M1).
- One host PC runs `llama-server` with `--rpc <worker1>,<worker2>,...` and
  `--tensor-split <proportions>`. The host owns the model file (GGUF) and
  the API; each worker holds and computes a slice of the model's layers.
- The split is by LAYERS (pipeline-style). Tensor-parallel over the network
  is not supported and would be far too slow anyway.
- llama-server speaks the OpenAI-shaped API, so Burn and the lore-keeper
  gate can point at the pool exactly like they point at Ollama today.
  Nothing about the bots changes.

## Hard requirements learned from the research

1. **Same llama.cpp version on every PC, exactly.** The RPC protocol is not
   version-negotiated; mismatched builds hang or crash. The pool pins one
   release tag; the prebuilt GitHub/winget binaries already have RPC
   compiled in, so nobody has to build from source — just install the same
   release everywhere. **Current pin (2026-11-15): v1.0.0 / build b12359**
   (RPC protocol v9 — it rejects incompatible peers outright). M1 uses the
   CUDA 12.8 build on the FX705 (engine + cudart archives), Vulkan/CPU
   b12359 on the Yoga.
2. **RPC has NO authentication.** Workers must bind to the tailnet only
   (Tailscale addresses), never a public interface. The tailnet Shea
   already runs is the pool's network and its security boundary.
3. **Pooling buys size, not speed.** Every remote layer pays a network
   round-trip. A pooled 14B will be smarter than phi4-mini but slower —
   good for lore-keeper/reasoning work; Burn's live roasts may stay on the
   local 3.8b for timing. Wired LAN beats Wi-Fi noticeably.
4. **The model exists only while enough PCs are on.** If the pooled memory
   drops below the model's size, it can't load. The page must show that
   honestly (pool memory vs. model size) instead of failing mysteriously.

## The pieces to build

### 1. Worker (each pooled PC)
- Install the pinned llama.cpp release.
- One start command, e.g.:
  `ggml-rpc-server -H <this PC's tailnet IP> -p 50052 -m <MB offered>`
- Later nicety: a tiny tray/startup script so it comes back on boot.

### 2. Coordinator + enrollment webpage (one PC — the FX705 fits: it
already hosts the gate and Ollama)

GPU tenancy on the FX705 (real constraint, flagged 2026-11-15): the
GTX 1650's 4 GB VRAM already serves Ollama (phi4-mini ≈ 2.4 GB
resident) and the Whisper transcription service. The pool's local
slice cannot share that card with Ollama's model and still fit — so
M1 measures with Ollama's model unloaded (the host script offers
this), and the production end state is that the pool REPLACES Ollama
on the FX705: once Burn and the lore-keeper point at the pool, Ollama
there retires and the contention disappears. Whisper stays — small
and bursty. If Ollama ever has to coexist with the pool, the split
shifts toward the Yoga's RAM and everything gets slower; that's the
fallback, not the plan.
- **Roster:** PCs that have joined — name, tailnet address, memory offered,
  up/down (probed live), which slice of the model each holds.
- **Join a PC:** enter its tailnet address + memory offered; the page
  verifies the worker answers, then it's in the pool. (No accounts — it's
  Shea's tailnet, Shea's page, same trust model as the bot dashboards.)
- **Pool total:** combined memory across live PCs, front and center.
- **Model picker:** GGUF models on the host's disk, each with its size;
  the picker shows whether the live pool can hold it (and how much is left
  for context/KV cache). Picking a model + Start relaunches llama-server
  with the right `--rpc` list and a `--tensor-split` computed from each
  live PC's offered memory.
- **Endpoint card:** the one address bots use (host tailnet IP + port),
  with copy buttons for the gate/Burn settings.

### 3. Consumers
- Lore-keeper gate first (quality win, latency-tolerant).
- Burn only if pooled speed proves good enough live; otherwise it keeps
  phi4-mini locally. Both can coexist — the pool is just another endpoint.

## Milestones

- **M1 — proof, no webpage:** llama.cpp **v1.0.0/b12359** on FX705 (CUDA
  12.8) + Yoga (Vulkan/CPU); rpc-server on the Yoga; llama-server on the
  FX705 running the pinned bartowski/huihui-ai Qwen3-14B-abliterated
  Q4_K_M (thinking disabled for Burn — see the runbook)
  split across both; measure tokens/sec and confirm coherent output.
  This is the whole risk of the project in one afternoon step.
- **M2 — the page:** roster + join + pool total, read-only status.
- **M3 — control:** model picker with fit check, Start/Stop, automatic
  tensor-split.
- **M4 — first consumer:** point the lore-keeper gate at the pool.

## Decisions (Shea, 2026-11-15)

1. **Target: 14B.** Q4_K_M ≈ 9 GB of weights — comfortably inside the
   FX705 + Yoga's combined memory, with room for context.
2. **Pool roster: FX705 + Yoga only.** The streaming PC is OUT — Shea
   needs its resources for gaming; the pool must never touch it.
3. **Burn uses the pooled 14B** — Shea explicitly wants Burn smarter, not
   kept on the local 3.8b. (Lore-keeper uses the pool too.) The M1 speed
   measurement is therefore a Burn check as much as a fit check: roasts
   are short and posts are 3 minutes apart, but banter replies are the
   timing-sensitive case to watch.
4. Coordinator on the FX705 (it already hosts the gate + Ollama).

## Added requirements (Shea, 2026-11-15)

### MCP support
The pool must work with MCP servers, in both directions:
- **The pool AS an MCP server:** the coordinator exposes MCP tools (chat
  with the pooled model, pool status, model list/pick) so any MCP client
  can use the pool directly, alongside the OpenAI-shaped HTTP API the
  bots use. Two front doors, same engine.
- **The pool USING MCP servers:** MCP servers can be registered with the
  coordinator and offered to the pooled model as tools, so a pooled
  session can reach Shea's other systems the MCP way.

### Hosted, easy install for anyone
The worker software is not just for Shea's laptops — it must be hosted
somewhere public and installable by anyone with minimal fuss:
- A public home serving one pinned package per platform: download,
  run, done. DECIDED 2026-11-15: that home is **tavernworks.dev itself**
  (see below) — no sending people off to GitHub or anywhere else.
- The installer is a small **pool worker app** wrapping llama.cpp's
  rpc-server: it asks for a pool name/address and how much memory to
  offer, registers with the coordinator, and starts on boot.
- **Flavours (CUDA required, Shea 2026-11-15):** the installer detects
  the GPU — NVIDIA gets the **CUDA** build (the full-performance path
  Shea's own FX705 uses), anything else gets the lean **Vulkan** build,
  CPU-only machines get CPU. One installer, right engine per machine,
  all packages shelved at pool.tavernworks.dev.
- **The pool dictates the llama.cpp version.** The worker checks the
  coordinator's pinned version and self-updates to match — this turns
  the fragile same-version rule into something the software enforces
  instead of something every user must remember.
- **Anyone-install changes the networking.** Strangers can't join Shea's
  tailnet, and RPC has no auth, so a public worker must never listen on
  an open port: the worker dials OUT to the coordinator (tunnel), and
  the coordinator talks back down that connection. Enrollment gets an
  approval step on the pool page (owner admits a machine before it can
  hold model layers) — a mining pool's "register your rig", with a gate.

M1 (FX705 + Yoga, hand-run) is unchanged and stays staged: it proves the
engine before any of this packaging is built.

## Shared usage (Shea, 2026-11-15: "I don't want to hoard the bot usage")

Contributors can also USE the pool. Design:

- **Accounts on the pool page.** Sign up, get a profile. The operator
  (Shea) approves enrollments (machines) and can approve accounts.
- **Three doors in, all per-user:**
  1. A **chat page** on the pool site — zero setup, works for anyone.
  2. A **personal API key** for the OpenAI-shaped endpoint — plug the
     pool into your own apps/bots, exactly like Burn connects.
  3. A **personal MCP endpoint/key** — the pool as an MCP server in
     Claude or any MCP client.
- **Fairness = mining-pool shares.** The coordinator tracks how much
  work each contributed PC actually serves (memory offered x time
  online x requests carried). Contributing earns usage balance;
  making requests spends it. Nobody — including Shea — can monopolise
  the model, and contributing is what earns the right to lean on it.
  DECIDED 2026-11-15: shares it is (Shea picked it over rate-limit-only
  and invite-only). Mechanics:
  - EARN: a PC accrues shares for memory offered x hours online, weighted
    up when its layers actually carry requests (a rig that's up but never
    used earns the base rate only).
  - SPEND: a request costs shares proportional to tokens generated.
  - New accounts start with a small free balance so people can try the
    pool before contributing; the operator can gift balance.
  - Balances and the earn/spend rates are shown on the pool page —
    mining pools publish their stats; so does this one.
- **One queue.** The pooled model serves a handful of conversations at
  once (llama-server parallel slots); everyone else's requests queue
  in the open, with position shown — no silent favouritism. Priority
  weight can come from contribution balance.
- **Operator controls:** Shea picks the model, sets earn/spend rates,
  per-user caps, and can pause public usage when the pool is needed
  for his own bots (Burn/lore-keeper keep a reserved lane so a busy
  public pool never starves them).
- **Trust caveat, stated plainly (CORRECTED 2026-11-15):** the first
  slice of a model sees token EMBEDDINGS, which are effectively the
  prompt in numeric form (recoverable by nearest-neighbour lookup),
  and the last slice sees LOGITS, which are effectively the reply.
  Middle slices see intermediate activations — far harder to invert,
  but not provably private. "Tensors, not text" was too generous;
  placement is the fix, below.

## Hosting: tavernworks.dev (DECIDED 2026-11-15)

Shea: the pool lives on the tavernworks.dev website, the installer is
downloaded from that site, and nothing redirects off tavernworks.

- The pool's pages live under **tavernworks.dev/pool/** — landing +
  how it works, the enrollment page, and downloads at
  **tavernworks.dev/pool/downloads/** (e.g. pool-worker-windows.zip).
- tavernworks.dev is a GitHub Pages site, so "hosted on the site" means
  the installer packages are committed into the tavernworks repo and
  Pages serves them at those URLs. Downloading never leaves the domain.
- **Size problem — FIXED by moving the shelf (Shea, 2026-11-15: CUDA
  support is required and the size limit "needs to be fixed"):**
  Shea is right — a CUDA worker package (llama.cpp CUDA binaries + the
  CUDA runtime package) runs to several hundred MB, and GitHub Pages
  hard-blocks files over ~100 MB with a ~1 GB total site cap. No
  chunking tricks; the downloads move off Pages entirely:
  - **pool.tavernworks.dev** is served by the **FX705 via Cloudflare
    Tunnel** — the exact pattern Town Crier already uses
    (crier.tavernworks.dev). Same domain, Shea's own server answering,
    no GitHub in the path. File size stops mattering: his disk is the
    limit, and version bumps are just replacing a file on the FX705.
  - The Pages site keeps the lightweight pool pages at
    tavernworks.dev/pool/ and links to pool.tavernworks.dev for the
    downloads and the coordinator — still inside tavernworks.dev,
    nothing redirects off it.
  - The coordinator was going to live on the FX705 anyway; now the
    downloads shelf lives with it, one tunnel for both.
  - **Big-download caveat — RESOLVED preemptively (Shea, 2026-11-15).**
    Verified facts: Cloudflare (Free/Pro/Business) caches files up to
    **512 MB each**, but its normal cache is per-datacenter and evicts
    unpopular files. The design answers all of it from day one:
    1. **Component split, hard rule: no single file over 512 MB.**
       Downloads are components, each independently versioned: the
       worker app (small), the llama.cpp engine per backend, and the
       CUDA runtime as its OWN component (if a future runtime ever
       crosses 512 MB it ships as two parts the installer joins).
    2. **Cache configured before launch, not after complaints:** a
       Cache Rule on pool.tavernworks.dev/downloads/* with long TTLs
       and versioned immutable file names (new version = new URL, no
       stale-cache fights); **Smart Tiered Cache on** (free) so every
       edge miss funnels through one upper tier — the FX705's upload
       fills each file roughly ONCE, not once per downloader;
       **Cache Reserve on** for the downloads path (pennies/GB in R2)
       so the big components persist instead of being evicted between
       downloads.
    3. **Component-wise self-update:** a llama.cpp version bump makes
       workers re-download the engine component only; the fat CUDA
       runtime changes rarely and stays put on machines and at the
       edge.
    4. **Resumable, verified downloads:** the FX705 file server honours
       Range requests and the installer checks a published SHA-256
       manifest — a dropped connection resumes a big pull instead of
       restarting it.
    Net effect: per release, home upload pays ~one pass of each
    component; Cloudflare's edge serves everyone else.
- The coordinator itself still runs on the FX705; the Pages site is the
  public face and the download shelf. Enrollment/accounts/shares live
  with the coordinator and are linked from the pool pages without
  sending the user off-domain (same-domain paths/subdomain only).

## Owner-first resource policy (Shea, 2026-11-15)

The pool is a guest on every machine. The owner's use ALWAYS wins —
"if a user is playing a game, their machine is not using the pool."

### On the worker (where the decision lives)
The worker app watches its own machine and yields on any of:
- A fullscreen app or known game/launcher process is running.
- The owner is present (recent keyboard/mouse) AND other programs are
  loading the GPU — the worker never competes for a busy GPU.
- Free VRAM/RAM falls below the owner's safety margin (the pool only
  ever holds what the owner offered, and games grabbing memory is
  itself a yield trigger).
- The machine is on battery, or the owner hits Pause.
Owner settings in the app: **yield-while-active is ON by default**,
optional schedules (e.g. pool only overnight), hard caps on memory
offered, and a big pause button. An idle pooled worker uses ~no GPU —
but its model layers DO sit in memory, which is exactly what a game
needs, so yielding means leaving, not just going quiet.

### On the coordinator (the honest mechanics)
A live split model can't shrink instantly — its layers physically sit
on the workers. So leaving is a **drain**, not a yank:
1. Worker signals "owner needs this machine" → coordinator marks it
   DRAINING and starts no new requests.
2. In-flight generations finish (seconds), then the coordinator
   reloads the model with a new split across the remaining machines;
   queued requests wait out the reshuffle (shown honestly in the
   queue, like a mining pool reconnect).
3. The worker exits and frees its memory entirely — the game gets
   everything back.
4. If a worker vanishes without draining (lid closed, killed), the
   in-flight request fails, the coordinator reloads without it, and
   queued work retries. The owner's machine is unaffected either way.
5. **No flapping:** a yielded machine rejoins only after it's been
   idle for a solid stretch (default 10 min) and only at a natural
   reshuffle point — never mid-queue just because it flickered free.

### Shares tie-in
Yielded time earns nothing (you're not serving), but there's no other
penalty — pausing for a game night costs only the shares those hours
would have earned. The pool page shows yield state plainly
("FX705 — owner gaming"), so a smaller pool at prime time is expected
and visible, not a mystery slowdown.

## Safety baseline (added 2026-11-15, at Shea's ask)

Beyond the tailnet rule and the tensor-privacy caveat already noted:

1. **Nothing raw is ever public.** Only the coordinator's own web/API
   front (accounts, queue, shares) is reachable at pool.tavernworks.dev.
   llama-server and every rpc-server stay on localhost/tailnet/tunnel
   interiors — the public internet can never speak to the engine
   directly.
2. **The public worker's tunnel is authenticated both ways.** Each
   enrolled machine gets its own key at approval time; the worker
   verifies it's talking to the real coordinator, the coordinator
   verifies the worker, and a key can be revoked on the pool page to
   ban a machine instantly. RPC itself never leaves that tunnel.
3. **Workers bind tight.** The worker app binds rpc-server to the
   tunnel interface only and adds a local firewall rule to match —
   nothing on a contributor's LAN can reach it either.
4. **Downloads and models are checksum-verified.** Installer components
   and the model GGUF are verified against a SHA-256 manifest served
   from pool.tavernworks.dev before anything runs or loads; the
   coordinator only ever loads models from its own catalog, never a
   file a user supplies.
5. **Accounts are abuse-resistant by construction.** API/MCP keys are
   hashed at rest and revocable per user; shares make spam expensive
   (every request spends balance); Cloudflare rate limits sit in front
   of the public doors; operator pages need Shea's login, and account
   + machine approvals stay manual.
6. **Minimal logging.** Shares accounting needs usage metadata (who,
   when, how many tokens) — it does NOT need prompt text. Prompts and
   replies are not logged by default; the usage page says so.
7. **Contributor machines get a watchdog.** On top of owner-first
   yielding: hard temperature/load back-off (a hot GPU drains just
   like a gaming one) and the memory cap is enforced by the worker app
   itself, not just requested.
8. **The shares ledger is append-only.** Balances derive from a log of
   earn/spend entries that is never edited in place — the pool's money
   can't be quietly rewritten, and disputes can be audited.

## Tensor visibility — addressed (2026-11-15)

**The rule: the operator holds the ends.** Layer slices are assigned
in order, so the coordinator always places the embedding + early
layers on Shea's own host (FX705) and the final layers + output head
on Shea's own iron too (the Yoga, as the last device in the split).
Contributors only ever hold MIDDLE layers — the slices whose data is
intermediate math, not readable prompts or replies.

**Privacy tiers for requests:**
- **Private** (Shea's bots by default; any user can choose it): the
  whole model runs on Shea's machines only. Costs more of his own
  pool share, never touches a contributor.
- **Community**: ends on Shea's machines, middles anywhere. The usage
  page explains exactly this, in plain words.

**Worker hygiene (so "we don't look" is verifiable, not a promise):**
- The worker software is open source — contributors and users can read
  what it does. It keeps tensors in RAM only, never writes them to
  disk, and holds no model file beyond its assigned slices.
- Slice assignments are written to the append-only ledger: which
  machine held which middle slice for which request is auditable
  after the fact.

**What this does NOT do (honest residual):** middle-activation
inversion is a real research technique — a determined attacker with
the model and serious compute could partially reconstruct inputs from
middle layers. Ends-on-operator + middles-only-for-strangers reduces
the exposure from "can read your chat" to "research project with
partial results". Fully cryptographic answers (homomorphic
encryption, secure enclaves) are either orders of magnitude too slow
or don't exist on consumer GPUs, so they are not promised. Transit is
already encrypted by the tunnel — that stops network snoopers, and
was never the same problem as operator visibility.

## Keeping the bots from taxing the pool (Shea, 2026-11-15)

The reserved lane means the pool can't starve the bots; this is the
other direction — the bots can't lean on the hardware either. Normal
bot load is tiny and predictable (Burn: ~40-token roasts minutes
apart; lore-keeper: on-demand chat). The real risk is a bot BUG —
a loop, a retry storm, a runaway generation — so every guardrail is
enforced by the COORDINATOR, per bot key, and holds even if the bot
misbehaves:

- **Output caps:** max tokens per request (roast-sized for Burn,
  reply-sized for the lore-keeper) plus a wall-clock timeout that
  cancels a generation that runs long. Nothing generates forever.
- **Pacing caps:** max requests/minute and max 1 concurrent request
  per bot — Burn's own scheduler already paces posts minutes apart;
  the coordinator's ceiling sits above that and below "problem".
- **Context caps:** bot requests have a context ceiling; oversized
  prompts are rejected, not absorbed by worker memory.
- **No retries against the pool:** a bot gets one attempt. If the
  pool is busy or the bot is over budget, the coordinator says so
  (429) and the bot falls back to its LOCAL model for that round —
  Burn still has phi4-mini on Ollama — instead of hammering the pool.
- **Bots never cause reloads:** model switches and reshuffles are
  operator actions on a schedule, not something request traffic can
  trigger.
- **It's all metered:** per-consumer requests/tokens show on the pool
  page from the ledger, so if a bot ever does tax the pool it's
  visible and attributable the same day.
And the contributor side is already covered: if bot load ever made a
pooled machine hot or busy, the thermal watchdog and owner-first
yield drain it out of the pool exactly like a game starting would.

## Public phase roadmap (added 2026-11-16, when Shea green-lit the start)

- **M5a — the public front door:** a separate public-front service on
  the FX705 (pool-front.py) behind the pool.tavernworks.dev
  Cloudflare Tunnel. Public-safe endpoints ONLY: /status.json
  (proxied from the tailnet coordinator), the downloads shelf
  (versioned components, SHA-256 manifest, Range/resumable), and
  the enrollment API (a machine registers -> pending -> the
  operator approves or revokes from the tailnet control page;
  the machine's key is shown once and stored hashed). The M3
  control page itself is NEVER tunnel-exposed — it stays
  tailnet-only, unauthenticated by design of the tailnet trust
  model.
- **M5b — the worker app + relay:** the downloadable worker
  (registers, waits for approval, runs the pinned rpc-server) and
  the dial-out relay: the worker holds a persistent outbound
  connection to the front; the front bridges it to a per-machine
  localhost port on the FX705 that llama-server can target.
  Per-machine keys gate the relay; revocation cuts it.
- **M5c — host integration:** the host script builds its --rpc
  list and tensor split from ALL live machines (tailnet + relayed
  public workers), ends staying on Shea's machines; first
  stranger-path test uses the Yoga enrolling as a public worker
  (its RPC travelling the relay, not its tailnet shortcut).
- **M6 — accounts + shares:** user accounts, personal API keys
  (hashed, revocable), web chat, the append-only shares ledger,
  starter balances, published stats; Burn/lore-keeper reserved
  lane; per-bot budgets from the guardrails section.
- **M7 — MCP both ways:** the pool as an MCP server (chat, status,
  model list) and registered MCP servers offered to the model.
