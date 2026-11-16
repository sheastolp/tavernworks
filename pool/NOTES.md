# AI Pool — idea (Shea, 2026-11-14, "for later")

A webpage where someone can enroll their PC to be used for AI responses.
Shea picks a model; all AI work flows through the pool of enrolled hardware.
Model: like a crypto mining pool — many machines contribute compute, one
coordinator routes the work.

Sketch of the shape (to design properly when Shea picks it up):
- Enrollment page: a PC joins the pool (runs a small worker — Ollama already
  fits: it serves models over an OpenAI-shaped API, which is what Burn and
  the gate already talk to).
- Coordinator: keeps the list of live workers, what model each has loaded,
  and routes each request to a free worker that has the picked model
  (queue when all are busy, like shares/jobs in a mining pool).
- Model picker on the page sets which model the pool serves.
- Open questions for later: who may enroll (just Shea's machines? friends?),
  trust/security of pooled PCs, load balancing vs. pinning a model per PC,
  what the first consumer is (Burn? the gate? both?).

Status: design written 2026-11-15 (DESIGN.md). Shea's decisions same day:
14B target; pool = FX705 + Yoga ONLY (streaming PC excluded, gaming);
Burn uses the pooled 14B (he wants it smarter); coordinator on FX705.
M1 STAGED by Shea 2026-11-15 ("leave it staged for later") — runbook
ready in M1-RUNBOOK.md, run when he says.
New requirements 2026-11-15: (1) MCP support — pool exposes an MCP server
and can use MCP servers as tools; (2) the worker software must be
publicly hosted and easily installable by ANYONE (installer pins/self-
updates the llama.cpp version; worker dials out to the coordinator;
owner approves enrollments). Folded into DESIGN.md.

## Clarified 2026-11-14 (same night)

NOT request routing. Shea wants ONE model split across ALL machines in the
pool — distributed inference — specifically to break past the ~4b model size
each of his PCs can run alone (current working models: phi4-mini 3.8b,
gemma3:4b). The pool's combined memory holds one bigger model; every machine
carries part of it.

What that means in practice (researched options, for the design pass):
- llama.cpp RPC: each PC runs a small rpc-server; one node loads the model
  with layers split across all of them. Works over LAN/Tailscale, tolerates
  slower links (layer/pipeline split). Most practical fit for his setup.
- exo: peer-to-peer, splits models across devices automatically; more
  experimental, Apple-leaning.
- Petals: swarm-style, HF models, research-grade.
- Ollama does NOT shard a model across machines (whole model per instance) —
  so the pooled big model would be llama.cpp-based even if Ollama stays for
  single-PC work.
Trade-off to design around: the big model only runs while enough pool PCs
are on and connected; interconnect speed caps tokens/sec.

Fairness DECIDED 2026-11-15: contribution shares, mining-pool style
(earn for memory-hours + work carried; spend per token generated;
starter balance for new accounts; stats published on the pool page).

Hosting DECIDED 2026-11-15: everything on tavernworks.dev — pool pages
under tavernworks.dev/pool/, installer downloads served from the site
itself (packages committed to the tavernworks repo for Pages; keep them
lean, Vulkan/CPU builds, <100 MB/file), NO redirects off tavernworks.

CUDA + size fix DECIDED 2026-11-15: Shea requires CUDA support; the
CUDA package (several hundred MB) busts GitHub Pages' ~100 MB/file and
~1 GB site limits, so downloads move to pool.tavernworks.dev, served by
the FX705 via Cloudflare Tunnel (Town Crier's pattern) — still
tavernworks.dev, no off-domain redirects, no size limit. Pages keeps
the light pool pages. Installer auto-picks CUDA (NVIDIA) / Vulkan /
CPU per machine.

Downloads caveat RESOLVED 2026-11-15 (preemptively, at Shea's ask):
components split with a hard <512 MB/file rule (Cloudflare's cache cap
on Free/Pro/Business); Cache Rule + Smart Tiered Cache + Cache Reserve
on the downloads path so the FX705 upload fills each file ~once and the
edge serves the world; component-wise self-updates (engine-only for
most bumps); resumable Range downloads with SHA-256 manifest.

Owner-first policy ADDED 2026-11-15: worker yields when the owner is
gaming/active (fullscreen/game process, owner present + GPU busy, low
free memory, battery, manual pause; yield-on-active default ON, plus
schedules + memory caps). Coordinator side is a DRAIN, not a yank —
finish in-flight, reload the model re-split across remaining PCs,
worker exits and frees all its memory; hard drops reload + retry.
Rejoin needs 10 min idle + a natural reshuffle point (no flapping).
Yielded time earns no shares, no other penalty.

M1 PINS APPLIED 2026-11-15 (Shea: "CUDA — pin it, update the runbook"):
llama.cpp v1.0.0/b12359 both laptops; FX705 = CUDA 12.8 engine + cudart
archives; Yoga = b12359 Vulkan/CPU; model = mradermacher
Qwen2.5-14B-Instruct-abliterated Q4_K_M (9.1 GB). Runbook + DESIGN.md
updated. Safety baseline section added to DESIGN.md the same day at
Shea's ask (public front only, authenticated worker tunnel, tight
worker binding, SHA-256 on downloads + models, hashed/revocable keys,
minimal logging, worker watchdog, append-only shares ledger).

Tensor visibility ADDRESSED 2026-11-15: corrected the earlier
"tensors, not text" understatement — first slice sees embeddings
(~= the prompt), last slice sees logits (~= the reply). Fix: OPERATOR
HOLDS THE ENDS (embeddings/early + final/output slices always on
Shea's FX705/Yoga; contributors get middle layers only), privacy
tiers (Private = Shea's machines only; Community = ends on Shea's,
middles anywhere), worker hygiene (open source, RAM-only tensors,
slice assignments in the append-only ledger). Honest residual: middle
activations are research-invertible in principle — risk reduction,
not a proof.

Model download/choice clarified 2026-11-15: model downloads from
Hugging Face (mradermacher repo; exact filename has DOTS —
Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf — verified live; the
runbook's earlier hyphenated filename was WRONG and has been fixed).
Choice in M1 = the -m argument on the FX705; the pool-page picker is
M3. Shea questioned instruct vs abliterated ("language issues"):
explained they're different axes and the pinned file is both —
instruct tuning for chat, abliteration so Burn's language isn't
refused/softened. Stock instruct remains an optional A/B in M1.

Model SWAPPED 2026-11-15 (Shea): M1 pin is now Qwen3-14B abliterated —
bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF, file
huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf (~9 GB, verified live).
Qwen3.5-14B abliterated instruct does NOT exist (the 3.5-14B name is a
14B-A3B MoE reasoning distillate). Qwen3 thinks by default — runbook's
start command disables it (--chat-template-kwargs enable_thinking
false) so nothing slow or think-y reaches Burn. The Qwen2.5 pin stays
in the runbook as the A/B alternative.

ONE-GO SESSION PACK built 2026-11-15 (Shea: "go from nothing to a
complete setup in one go"): ai-pool/m1/ holds SESSION.md (the single
sitting: FX705 script first for the big downloads, Yoga worker while
they run, test, optional Burn flip with flip-back) + yoga-worker.sh,
fx705-host.sh, test-pool.sh — all pinned to b12359 with version
asserts, the model verified by SHA-256
(d76889059a3bfab30bc565012a0184827ff2bdc10197f6babc24541b98451dbe,
9,001,749,568 bytes, from HF's file list), worker reachability proven
before the 9 GB load. Scripts syntax-checked; still untested on the
real laptops — M1 itself remains staged for Shea's sitting.

Bot-load guardrails ADDED 2026-11-15 (Shea: bots must not tax the
pool's hardware): coordinator-enforced per-bot budgets — output token
caps + generation timeout, request pacing + 1 concurrent per bot,
context ceiling, NO retries against the pool (busy/over-budget → bot
falls back to its local model for that round), bots never trigger
model reloads, per-consumer usage metered on the pool page. Reserved
lane protects bots from the pool; these protect the pool from bots.
