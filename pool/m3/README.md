# AI Pool M3 — control

The coordinator: a small service on the FX705 that serves the pool's
control page on the tailnet (http://100.100.40.72:8091/). Per the
design, the tailnet is the trust boundary — this page never faces
the public internet.

What it does:

- **Live status** — brain health/model, service states, GPU and RAM,
  each roster machine probed (workers on their RPC port), pool total.
- **Model picker with fit check** — every GGUF on the host's disk,
  its size, and whether solo mode (GPU + free RAM, 1 GB context
  reserve) or split mode (the card's proven 3 GB cap + workers'
  offered memory) can hold it. Picking a model writes
  `current-model.txt`; the solo and host scripts read it at startup
  (argument → that file → the Qwen2.5 default). If a brain is
  running, picking restarts it with the new model.
- **Start/Stop** — solo and split via systemd (the units conflict,
  so the two modes can never fight over the GPU and port). Split
  first writes `pool-split.txt`, computed from the roster:
  each worker's share is its offered memory over the card's cap,
  rounded — the M1 numbers (6144 offered, 3072 cap) reproduce the
  proven 2,1.
- **Roster + join** — offered memory is editable per machine; a new
  PC joins by name + tailnet address + offered MB, and only after
  the page verifies it answers on the worker port (50052).
- **Endpoint card** — the brain's address and the exact env lines
  Burn uses.
- **/status.json** — the same shape the public pool page
  (tavernworks.dev/pool/) already tries to read; it goes live
  whenever pool.tavernworks.dev is pointed at this service.

## Install (FX705, as root)

Order matters — scripts first, then units, so no combination can
load the wrong model:

```sh
RAW="https://api.github.com/repos/sheastolp/tavernworks/contents"
H='Accept: application/vnd.github.raw'
curl -fsSL -H "$H" "$RAW/pool/m1/fx705-solo.sh" -o ~/ai-pool-m1/fx705-solo.sh
curl -fsSL -H "$H" "$RAW/pool/m1/fx705-host.sh" -o ~/ai-pool-m1/fx705-host.sh
curl -fsSL -H "$H" "$RAW/pool/m3/pool-coordinator.py" -o ~/ai-pool-m1/pool-coordinator.py
curl -fsSL -H "$H" "$RAW/pool/m3/pool-config.json" -o ~/ai-pool-m1/pool-config.json
cp ~/ai-pool-m1/fx705-solo.sh ~/ai-pool-m1/fx705-host.sh ~/ai-pool-m1/pool-coordinator.py /opt/ai-pool/
chmod +x /opt/ai-pool/fx705-solo.sh /opt/ai-pool/fx705-host.sh
cp -n ~/ai-pool-m1/pool-config.json ~/ai-pool/pool-config.json
echo "Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf" > ~/ai-pool/current-model.txt
curl -fsSL -H "$H" "$RAW/pool/m1/ai-pool-solo.service" -o /etc/systemd/system/ai-pool-solo.service
curl -fsSL -H "$H" "$RAW/pool/m1/ai-pool-host.service" -o /etc/systemd/system/ai-pool-host.service
curl -fsSL -H "$H" "$RAW/pool/m3/pool-coordinator.service" -o /etc/systemd/system/pool-coordinator.service
systemctl daemon-reload
systemctl restart ai-pool-solo
systemctl enable --now pool-coordinator
```

Verify: the control page at http://100.100.40.72:8091/ shows the
brain online with the Qwen2.5, the roster with the Yoga probed,
and Burn's dashboard still green after the solo restart.
